#!/usr/bin/env ruby
# frozen_string_literal: true

# Deletes preview images whose pull request is gone.
#
#   prune-images.rb [--dry-run]
#
# Environment:
#   PACKAGE            container package name (default: preview-app)
#   GITHUB_REPOSITORY  owner/repo the pull requests live in
#   RETENTION_DAYS     delete pr-* images older than this regardless (default: 30)
#   PROTECT_TAG        never delete this tag — what production is pinned to
#   GH_TOKEN           needs read:packages and delete:packages
#
# Every push to a pull request publishes an image. Nothing deleted them, so the
# registry accumulated one per push forever — the same leak as the namespaces
# that survived pruning, in a different place, and just as invisible.
#
# Talks to the API directly rather than shelling out to `gh` per call: forty-odd
# deletions meant forty process launches, which ran past a fifteen minute job
# timeout and left the work half done.

require 'json'
require 'net/http'
require 'time'
require 'uri'

PACKAGE = ENV.fetch('PACKAGE', 'preview-app')
OWNER, REPO = ENV.fetch('GITHUB_REPOSITORY', '/').split('/', 2)
RETENTION_DAYS = Integer(ENV.fetch('RETENTION_DAYS', '30'))
PROTECT_TAG = ENV['PROTECT_TAG'].to_s
TOKEN = ENV['GH_TOKEN'].to_s
DRY_RUN = ARGV.include?('--dry-run')

abort 'GITHUB_REPOSITORY must be owner/repo' if OWNER.to_s.empty? || REPO.to_s.empty?
abort 'GH_TOKEN is not set' if TOKEN.empty?

def request(http, method, path)
  klass = { get: Net::HTTP::Get, delete: Net::HTTP::Delete }.fetch(method)
  req = klass.new(path)
  req['Authorization'] = "Bearer #{TOKEN}"
  req['Accept'] = 'application/vnd.github+json'
  req['X-GitHub-Api-Version'] = '2022-11-28'
  req['User-Agent'] = 'prune-images'
  http.request(req)
end

# Follows Link headers rather than guessing how many pages there are.
def all_pages(http, path)
  items = []
  loop do
    res = request(http, :get, path)
    abort "GET #{path} returned #{res.code}: #{res.body.to_s[0, 200]}" unless res.code == '200'

    items.concat(JSON.parse(res.body))
    nxt = res['link'].to_s[/<([^>]+)>;\s*rel="next"/, 1]
    break unless nxt

    path = URI(nxt).request_uri
  end
  items
end

http = Net::HTTP.new('api.github.com', 443)
http.use_ssl = true
http.start

versions = all_pages(http, "/user/packages/container/#{PACKAGE}/versions?per_page=100")
puts "#{versions.size} versions in ghcr.io/#{OWNER.downcase}/#{PACKAGE}"

pr_state = {}
all_pages(http, "/repos/#{OWNER}/#{REPO}/pulls?state=all&per_page=100")
  .each { |pr| pr_state[pr['number']] = pr['state'] }

# Deciding from an empty list would delete every preview image at once.
abort 'no pull requests returned — refusing to decide anything from that' if pr_state.empty?

cutoff = Time.now - (RETENTION_DAYS * 24 * 60 * 60)
doomed = []
kept = Hash.new(0)

versions.each do |version|
  tags = version.dig('metadata', 'container', 'tags') || []

  # Untagged versions are the per-architecture children of a multi-arch index.
  # Deleting them leaves the tagged image referencing manifests that no longer
  # exist — a pull that fails with no obvious cause. Only whole tagged images
  # are removed here; GitHub collects the orphans.
  if tags.empty?
    kept[:untagged] += 1
    next
  end

  if PROTECT_TAG != '' && tags.include?(PROTECT_TAG)
    kept[:production] += 1
    next
  end

  # An unreadable timestamp means the API changed, not that the image is new.
  # Guessing wrong here deletes things.
  created = begin
    Time.parse(version.fetch('created_at'))
  rescue ArgumentError, TypeError, KeyError
    abort "version #{version['id']}: cannot read created_at"
  end
  old = created < cutoff

  if (pr_tag = tags.find { |t| t.start_with?('pr-') })
    number = pr_tag.split('-')[1].to_i
    if pr_state[number] == 'closed'
      doomed << [version, tags, "pull request ##{number} is closed"]
    elsif old
      doomed << [version, tags, "older than #{RETENTION_DAYS} days"]
    else
      kept[:open_pr] += 1
    end
    next
  end

  # Releases are worth keeping for a rollback, but not forever.
  if old
    doomed << [version, tags, "release older than #{RETENTION_DAYS} days"]
  else
    kept[:recent_release] += 1
  end
end

# A bug in the tag parsing would otherwise take the whole registry.
if doomed.size > versions.size * 0.9 && versions.size > 5
  abort "refusing to delete #{doomed.size} of #{versions.size} versions — that is almost everything"
end

puts
puts "keeping: #{kept.map { |k, v| "#{v} #{k}" }.join(', ')}"
puts "deleting: #{doomed.size}"
puts

failures = 0
doomed.each_with_index do |(version, tags, why), i|
  label = "#{tags.join(', ')} (#{why})"

  if DRY_RUN
    puts "  would delete  #{label}"
    next
  end

  res = request(http, :delete, "/user/packages/container/#{PACKAGE}/versions/#{version['id']}")
  # 404 means somebody else already removed it, which is the outcome we wanted.
  if %w[204 404].include?(res.code)
    puts "  [#{i + 1}/#{doomed.size}] deleted  #{label}"
  else
    failures += 1
    warn "  [#{i + 1}/#{doomed.size}] FAILED #{res.code}  #{label}"
  end
end

http.finish

puts
if DRY_RUN
  puts 'dry run — nothing was deleted'
elsif failures.positive?
  abort "#{failures} of #{doomed.size} deletions failed"
else
  puts "removed #{doomed.size} versions"
end
