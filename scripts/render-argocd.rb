#!/usr/bin/env ruby
# frozen_string_literal: true

# Renders an ArgoCD manifest and validates the onboarded repositories.
#
#   render-argocd.rb <manifest>
#
# Environment: PREVIEW_BASE_HOST, TLS_ENABLED, TLS_ISSUER, PROD_IMAGE_TAG
#
# ArgoCD reads deploy/platform/onboarded/ itself, so nothing about the
# repositories is baked into what this prints. The validation is here anyway,
# because a malformed file would otherwise surface as an environment that
# silently never appears — the worst way to learn about a typo.

require 'yaml'

manifest_path = ARGV[0]
abort 'usage: render-argocd.rb <manifest>' unless manifest_path

ROOT = File.expand_path('..', __dir__)
PLATFORM = File.join(ROOT, 'deploy/platform/platform.yaml')
ONBOARDED = File.join(ROOT, 'deploy/platform/onboarded')

platform = YAML.safe_load(File.read(PLATFORM))
%w[chartRepo chartRevision chartPath].each do |key|
  abort "#{PLATFORM}: #{key} is required" if platform[key].to_s.strip.empty?
end

REQUIRED = %w[slug owner repo image port healthPath database].freeze

files = Dir[File.join(ONBOARDED, '*.yaml')].sort
abort "no repositories onboarded in #{ONBOARDED}" if files.empty?

slugs = files.map do |file|
  entry = YAML.safe_load(File.read(file))
  abort "#{file}: expected a mapping" unless entry.is_a?(Hash)

  missing = REQUIRED.reject { |k| entry[k].to_s.strip != '' }
  abort "#{file}: missing #{missing.join(', ')}" if missing.any?

  # The slug lands in namespace names and hostnames, both of which are DNS
  # labels. Catching it here beats a sync failing on the cluster later.
  unless entry['slug'].to_s.match?(/\A[a-z0-9]([a-z0-9-]*[a-z0-9])?\z/)
    abort "#{file}: slug '#{entry['slug']}' must be lowercase letters, digits and dashes"
  end

  # ArgoCD substitutes generator values into strings. An unquoted port arrives
  # as an integer and fails templating with a message that points nowhere near
  # the file that caused it.
  unless entry['port'].is_a?(String)
    abort "#{file}: port must be quoted, so it reaches ArgoCD as a string"
  end

  # Same reason, and the same failure mode: the ApplicationSet substitutes
  # {{database}} straight into a Helm parameter, so it has to arrive as the
  # string "true" or "false". A YAML boolean becomes `true` unquoted and a
  # missing key leaves the placeholder in the manifest, both of which surface
  # as an environment that never appears rather than as an error here.
  unless %w[true false].include?(entry['database'])
    abort "#{file}: database must be the quoted string \"true\" or \"false\", got #{entry['database'].inspect}"
  end

  # One file per slug keeps deletion obvious, and two files claiming the same
  # slug would silently share a namespace.
  expected = "#{entry['slug']}.yaml"
  unless File.basename(file) == expected
    abort "#{file}: should be named #{expected}, after its slug"
  end

  entry['slug']
end

# Counted with group_by rather than `slugs - slugs.uniq`, which is always empty
# because array subtraction removes every occurrence of whatever it finds. This
# also keeps working on Ruby 2.6, which is what macOS still ships.
duplicates = slugs.group_by(&:itself).select { |_, occurrences| occurrences.size > 1 }.keys
abort "duplicate slugs: #{duplicates.join(', ')}" if duplicates.any?

out = File.read(manifest_path)
out = out.gsub('__CHART_REPO__', platform.fetch('chartRepo'))
out = out.gsub('__CHART_REVISION__', platform.fetch('chartRevision'))
out = out.gsub('__CHART_PATH__', platform.fetch('chartPath'))
out = out.gsub('__SOURCE_REPOS__', "    - #{platform.fetch('chartRepo')}")
base_host = ENV.fetch('PREVIEW_BASE_HOST', '')
tls_on = ENV.fetch('TLS_ENABLED', 'false') == 'true'
issuer = ENV.fetch('TLS_ISSUER', 'selfsigned')

# Both substitutions have to leave valid YAML whether or not TLS is on, so the
# "off" case is a comment rather than an empty line in the middle of a mapping.
out = out.gsub(
  '__TLS_ANNOTATION__',
  tls_on ? "cert-manager.io/cluster-issuer: #{issuer.inspect}" : '# TLS disabled on this cluster',
)
out = out.gsub(
  '__TLS_BLOCK__',
  if tls_on
    "tls:\n    - hosts:\n        - \"argocd-webhook.#{base_host}\"\n      secretName: argocd-webhook-tls"
  else
    '# TLS disabled on this cluster'
  end,
)
out = out.gsub('__PREVIEW_BASE_HOST__', base_host)
out = out.gsub('__TLS_ENABLED__', ENV.fetch('TLS_ENABLED', 'false'))
out = out.gsub('__TLS_ISSUER__', ENV.fetch('TLS_ISSUER', 'selfsigned'))
out = out.gsub('__PROD_IMAGE_TAG__', ENV.fetch('PROD_IMAGE_TAG', 'latest'))

# Cluster-wide secret material. Empty is a supported state — it turns preview
# passwords off rather than deriving one from a known salt — so this is not
# validated as required. bootstrap-cluster.sh generates it once and keeps it in
# argocd-secret, so re-running the bootstrap does not invalidate the passwords
# already posted on open pull requests.
out = out.gsub('__SECRET_SALT__', ENV.fetch('PREVIEW_SECRET_SALT', ''))

# A placeholder that survives rendering would be applied literally and fail in
# a way that points at the cluster rather than at this script.
leftover = out.scan(/__[A-Z_]+__/).uniq
abort "#{manifest_path}: unsubstituted placeholders: #{leftover.join(', ')}" if leftover.any?

# Prove it is still YAML before it reaches the cluster.
begin
  YAML.safe_load(out, aliases: true)
rescue Psych::SyntaxError => e
  abort "#{manifest_path}: rendered to invalid YAML: #{e.message}"
end

print out
