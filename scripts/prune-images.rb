#!/usr/bin/env ruby
# frozen_string_literal: true

# Deletes preview images whose pull request is gone.
#
#   prune-images.rb [--dry-run]
#
# Environment:
#   PACKAGE          container package name (default: preview-app)
#   OWNER            GitHub owner (default: from GITHUB_REPOSITORY)
#   REPO             repository the pull requests live in
#   RETENTION_DAYS   delete pr-* images older than this regardless (default: 30)
#   PROTECT_TAG      never delete this tag — what production is pinned to
#   GH_TOKEN         needs read:packages and delete:packages
#
# Every push to a pull request publishes an image. Nothing deleted them, so the
# registry accumulated one per push forever — the same leak as the namespaces
# that survived pruning, in a different place, and just as invisible.

require 'json'
require 'open3'
require 'time'

PACKAGE = ENV.fetch('PACKAGE', 'preview-app')
OWNER, REPO_FROM_ENV = ENV.fetch('GITHUB_REPOSITORY', '/').split('/', 2)
REPO = ENV.fetch('REPO', REPO_FROM_ENV.to_s)
RETENTION_DAYS = Integer(ENV.fetch('RETENTION_DAYS', '30'))
PROTECT_TAG = ENV['PROTECT_TAG'].to_s
DRY_RUN = ARGV.include?('--dry-run')

abort 'GITHUB_REPOSITORY or OWNER/REPO must be set' if OWNER.to_s.empty? || REPO.empty?

def gh(*args)
  out, err, status = Open3.capture3('gh', *args)
  raise "gh #{args.first(2).join(' ')} failed: #{err.strip}" unless status.success?

  out
end

versions = JSON.parse(
  gh('api', '--paginate', "user/packages/container/#{PACKAGE}/versions", '--slurp',
     '--jq', '[.[][] | {id, created_at, tags: .metadata.container.tags}]'),
)

puts "#{versions.size} versions in ghcr.io/#{OWNER.downcase}/#{PACKAGE}"

# Which pull requests still exist, and which are closed.
pr_state = {}
JSON.parse(
  gh('api', '--paginate', "repos/#{OWNER}/#{REPO}/pulls?state=all&per_page=100", '--slurp',
     '--jq', '[.[][] | {number, state}]'),
).each { |pr| pr_state[pr['number']] = pr['state'] }

cutoff = Time.now - (RETENTION_DAYS * 24 * 60 * 60)
doomed = []
kept = Hash.new(0)

versions.each do |version|
  tags = version['tags'] || []

  # Untagged versions are the per-architecture children of a multi-arch index.
  # Deleting them leaves the tagged image referencing manifests that no longer
  # exist — a broken pull with no obvious cause. Only whole tagged images are
  # ever removed here; GitHub collects the orphans.
  if tags.empty?
    kept[:untagged] += 1
    next
  end

  if PROTECT_TAG != '' && tags.include?(PROTECT_TAG)
    kept[:production] += 1
    next
  end

  # An unparseable date means something changed in the API, not that the image
  # is new. Fail rather than guess, since guessing wrong here deletes things.
  created = begin
    Time.parse(version['created_at'])
  rescue ArgumentError, TypeError
    abort "version #{version['id']}: cannot read created_at #{version['created_at'].inspect}"
  end
  age_ok = created < cutoff

  pr_tag = tags.find { |t| t.start_with?('pr-') }
  if pr_tag
    number = pr_tag.split('-')[1].to_i
    state = pr_state[number]

    if state == 'closed'
      doomed << [version, tags, "pull request ##{number} is closed"]
    elsif age_ok
      doomed << [version, tags, "older than #{RETENTION_DAYS} days"]
    else
      kept[:open_pr] += 1
    end
    next
  end

  # main-* images are releases. Old ones are still worth keeping around for a
  # rollback, but not forever.
  if age_ok
    doomed << [version, tags, "release older than #{RETENTION_DAYS} days"]
  else
    kept[:recent_release] += 1
  end
end

# A bug in the tag parsing, or an empty pull request list from a failed API
# call, would otherwise delete the entire registry in one run.
if doomed.size > versions.size * 0.9 && versions.size > 5
  abort "refusing to delete #{doomed.size} of #{versions.size} versions — that is almost everything"
end

puts
puts "keeping: #{kept.map { |k, v| "#{v} #{k}" }.join(', ')}"
puts "deleting: #{doomed.size}"
puts

doomed.each do |version, tags, why|
  label = "#{tags.join(', ')} (#{why})"
  if DRY_RUN
    puts "  would delete  #{label}"
  else
    gh('api', '-X', 'DELETE', "user/packages/container/#{PACKAGE}/versions/#{version['id']}")
    puts "  deleted       #{label}"
  end
end

puts
puts DRY_RUN ? 'dry run — nothing was deleted' : "removed #{doomed.size} versions"
