#!/usr/bin/env ruby
# frozen_string_literal: true

# Discovers repositories that have opted in, and writes the onboarding files
# ArgoCD reads.
#
#   discover-repos.rb
#
# Environment:
#   PREVIEW_TOPIC   GitHub topic to search for (default: pr-preview)
#   MAX_REPOS       how many to serve (default: 10)
#
#   GH_TOKEN        used by the gh CLI
#
# On capacity: this caps repositories, the reusable build workflow caps
# environments per repository, and the theoretical worst case is the product of
# the two — which exceeds the node, and always will, because caps that multiply
# safely would have to be uselessly small. The honest model is in
# docs/capacity.md: these two are preventive, stopping any one repository
# monopolising the cluster, and the TooManyPreviewEnvironments alert is the
# backstop that catches the aggregate. A heavy application meeting a full node
# gets Pending pods rather than a broken cluster, which is the failure worth
# having.
#
# Opting in is a topic on the repository plus .github/preview.yml. Nobody has
# to be asked and nobody approves, which is the point — and also why the
# decisions below are made the way they are.
#
# The config path is deliberately specific. `pr-preview` is a topic other
# projects already use: a live run found seven unrelated repositories carrying
# it. A file named `.preview.yml` in a repository root could plausibly exist
# for some other reason, and being silently deployed to a stranger's cluster is
# not something anyone should be able to opt into by accident.

require 'digest'
require 'json'
require 'yaml'
require 'fileutils'
require 'open3'

ROOT = File.expand_path('..', __dir__)
ONBOARDED = File.join(ROOT, 'deploy/platform/onboarded')
TOPIC = ENV.fetch('PREVIEW_TOPIC', 'pr-preview')
MAX_REPOS = Integer(ENV.fetch('MAX_REPOS', '10'))
CONFIG_PATH = '.github/preview.yml'

def gh(*args)
  out, err, status = Open3.capture3('gh', *args)
  raise "gh #{args.join(' ')} failed: #{err.strip}" unless status.success?

  out
end

# Slugs are derived, never chosen.
#
# They appear in namespaces and hostnames, so two repositories claiming the
# same one would share an environment. With onboarding open to anyone, a chosen
# slug is also squattable: whoever asks for "app" first owns it, and everyone
# else is stuck. Deriving it from owner and repository makes it unique by
# construction and unarguable.
#
# Truncated because the whole `<slug>-pr-<number>` has to fit in a 63-character
# DNS label, and the digest keeps truncated names from colliding.
def slug_for(owner, repo)
  base = "#{owner}-#{repo}".downcase.gsub(/[^a-z0-9]+/, '-').gsub(/\A-+|-+\z/, '')
  return base if base.length <= 45

  "#{base[0, 38]}-#{Digest::SHA256.hexdigest(base)[0, 6]}"
end

puts "Searching for repositories with topic '#{TOPIC}'"

results = JSON.parse(
  gh('api', '-X', 'GET', 'search/repositories',
     '-f', "q=topic:#{TOPIC} is:public",
     '-f', 'per_page=100',
     '--jq', '[.items[] | {full_name, owner: .owner.login, name, pushed_at}]'),
)

puts "  #{results.size} repositories carry the topic"

# Deterministic and not gameable by pushing: most recently created first would
# reward spam, and alphabetical is at least stable across runs.
results.sort_by! { |r| r['full_name'].downcase }

onboarded = []
skipped = []

results.each do |repo|
  full = repo['full_name']

  if onboarded.size >= MAX_REPOS
    skipped << [full, "capacity: already serving #{MAX_REPOS}"]
    next
  end

  begin
    raw = gh('api', "repos/#{full}/contents/#{CONFIG_PATH}", '--jq', '.content')
    config = YAML.safe_load(raw.strip.unpack1('m'))
  rescue StandardError
    skipped << [full, "no #{CONFIG_PATH}"]
    next
  end

  unless config.is_a?(Hash)
    skipped << [full, "#{CONFIG_PATH} is not a mapping"]
    next
  end

  port = config['port'].to_s.strip
  unless port.match?(/\A\d{2,5}\z/)
    skipped << [full, "port must be a number, got '#{config['port']}'"]
    next
  end

  health = config.fetch('healthPath', '/').to_s.strip
  unless health.start_with?('/')
    skipped << [full, "healthPath must start with /, got '#{health}'"]
    next
  end

  image_name = config.fetch('image', repo['name']).to_s.strip.downcase
  # The whole point of composing the reference as ghcr.io/<owner>/<image> is
  # that a repository can only ever name images inside its own namespace. A
  # `..` segment escapes that, so path traversal is rejected explicitly rather
  # than left to the registry to refuse.
  if image_name.match?(%r{\A\.\.\z|\A\.\./|/\.\./|/\.\.\z})
    skipped << [full, "image '#{image_name}' may not contain a '..' path segment"]
    next
  end
  unless image_name.match?(%r{\A[a-z0-9][a-z0-9._/-]*\z})
    skipped << [full, "image '#{image_name}' is not a valid image name"]
    next
  end

  # Opt-in, and expensive: a Postgres per pull request is the largest thing
  # this platform will place on a single node, so it is off unless asked for.
  # Written as a string because the ApplicationSet substitutes it straight into
  # a Helm parameter, where a YAML boolean would arrive unquoted.
  database = config.fetch('database', false)
  unless [true, false].include?(database)
    skipped << [full, "database must be true or false, got '#{config['database']}'"]
    next
  end

  slug = slug_for(repo['owner'], repo['name'])

  onboarded << {
    'slug' => slug,
    'owner' => repo['owner'],
    'repo' => repo['name'],
    'image' => "ghcr.io/#{repo['owner'].downcase}/#{image_name}",
    'port' => port,
    'healthPath' => health,
    'database' => database.to_s,
  }
end

# A search that returns nothing — a GitHub outage, a bad token, a renamed topic
# — would otherwise offboard every repository at once and delete every
# environment on the cluster. Refuse instead.
if onboarded.empty?
  warn 'discovery found no valid repositories; leaving the existing files alone'
  warn 'if that is genuinely correct, delete the files by hand'
  exit 1
end

FileUtils.mkdir_p(ONBOARDED)
existing = Dir[File.join(ONBOARDED, '*.yaml')].map { |f| File.basename(f) }
written = []

onboarded.each do |entry|
  file = "#{entry['slug']}.yaml"
  written << file
  path = File.join(ONBOARDED, file)

  body = +"# Generated by scripts/discover-repos.rb — do not edit.\n" \
          "# #{entry['owner']}/#{entry['repo']} opted in with the '#{TOPIC}' topic\n" \
          "# and #{CONFIG_PATH}. Removing either removes this file, and with it\n" \
          "# every environment that repository had.\n"
  body << entry.to_yaml.sub(/\A---\n/, '')

  File.write(path, body)
end

(existing - written).each do |file|
  puts "  offboarding #{file} (topic or .preview.yml removed)"
  File.delete(File.join(ONBOARDED, file))
end

puts
puts "Serving #{onboarded.size} repositories:"
onboarded.each { |e| puts "  #{e['slug']}  <- #{e['owner']}/#{e['repo']}  :#{e['port']}#{e['healthPath']}" }

unless skipped.empty?
  puts
  puts 'Skipped:'
  skipped.each { |full, why| puts "  #{full} — #{why}" }
end
