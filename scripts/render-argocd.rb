#!/usr/bin/env ruby
# frozen_string_literal: true

# Renders an ArgoCD manifest, substituting both the simple placeholders and the
# two blocks derived from the onboarded-repositories registry.
#
#   render-argocd.rb <manifest> <registry>
#
# Environment: PREVIEW_BASE_HOST, TLS_ENABLED, TLS_ISSUER, PROD_IMAGE_TAG
#
# The blocks are generated rather than written by hand so the set of
# repositories ArgoCD watches, and the set it is permitted to deploy from,
# cannot drift apart — they are two views of one file.

require 'yaml'

manifest_path, registry_path = ARGV
abort 'usage: render-argocd.rb <manifest> <registry>' unless manifest_path && registry_path

registry = YAML.safe_load(File.read(registry_path))
repos = registry.fetch('repos', [])
abort "no repositories listed in #{registry_path}" if repos.empty?

platform = registry.fetch('platform', {})
%w[chartRepo chartRevision chartPath].each do |key|
  abort "#{registry_path}: platform.#{key} is required" if platform[key].to_s.strip.empty?
end

REQUIRED = %w[slug owner repo image port healthPath].freeze

repos.each do |r|
  missing = REQUIRED.reject { |k| r[k].to_s.strip != '' }
  abort "#{registry_path}: entry #{r['slug'] || '(no slug)'} is missing #{missing.join(', ')}" if missing.any?

  # The slug lands in namespace names and hostnames, both of which are DNS
  # labels. Catching it here beats a sync failing on the cluster later.
  unless r['slug'].match?(/\A[a-z0-9]([a-z0-9-]*[a-z0-9])?\z/)
    abort "#{registry_path}: slug '#{r['slug']}' must be lowercase letters, digits and dashes"
  end
end

# Counted with group_by rather than `slugs - slugs.uniq`, which is always empty
# because array subtraction removes every occurrence of whatever it finds — the
# error would have named no slug at all. group_by also keeps this working on
# Ruby 2.6, which is what macOS still ships.
duplicates = repos.map { |r| r['slug'] }
                  .group_by(&:itself)
                  .select { |_, occurrences| occurrences.size > 1 }
                  .keys
abort "#{registry_path}: duplicate slugs: #{duplicates.join(', ')}" if duplicates.any?

# ArgoCD substitutes list-generator values into strings, so every value has to
# be one — an unquoted port would arrive as an integer and fail templating.
elements = repos.map do |r|
  [
    "                - slug: #{r['slug'].to_s.inspect}",
    "                  owner: #{r['owner'].to_s.inspect}",
    "                  repo: #{r['repo'].to_s.inspect}",
    "                  image: #{r['image'].to_s.inspect}",
    "                  port: #{r['port'].to_s.inspect}",
    "                  healthPath: #{r['healthPath'].to_s.inspect}",
  ].join("\n")
end.join("\n")

# Only the chart repository, because that is the only thing an Application
# built here ever deploys from. Listing the onboarded repositories would permit
# more than the platform actually does.
source_repos = ["    - #{platform.fetch('chartRepo')}"].join("\n")

out = File.read(manifest_path)
out = out.gsub('__REPO_ELEMENTS__', elements)
out = out.gsub('__SOURCE_REPOS__', source_repos)
out = out.gsub('__CHART_REPO__', platform.fetch('chartRepo'))
out = out.gsub('__CHART_REVISION__', platform.fetch('chartRevision'))
out = out.gsub('__CHART_PATH__', platform.fetch('chartPath'))
out = out.gsub('__PREVIEW_BASE_HOST__', ENV.fetch('PREVIEW_BASE_HOST', ''))
out = out.gsub('__TLS_ENABLED__', ENV.fetch('TLS_ENABLED', 'false'))
out = out.gsub('__TLS_ISSUER__', ENV.fetch('TLS_ISSUER', 'selfsigned'))
out = out.gsub('__PROD_IMAGE_TAG__', ENV.fetch('PROD_IMAGE_TAG', 'latest'))
out = out.gsub('__OWNER__', repos.first['owner'].to_s)
out = out.gsub('__OWNER_LC__', repos.first['owner'].to_s.downcase)

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
