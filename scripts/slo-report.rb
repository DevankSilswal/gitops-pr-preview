#!/usr/bin/env ruby
# frozen_string_literal: true

# Turns the recorded provisioning measurements into percentiles and an SLO
# verdict.
#
#   slo-report.rb [--window-days N] [--markdown]
#
# Environment:
#   SLO_SECONDS   the objective, in seconds (default: 120)
#   SLO_TARGET    fraction that must meet it (default: 0.95)
#
# The service level indicator is the platform's actual promise: open a pull
# request, get a working URL. Everything else here — the webhook instead of
# polling, the wait-before-commenting, the retry backoff on image pulls — is
# either worth something against that number or it is decoration, and until
# this existed there was no way to tell which.
#
# Reads metrics/provisioning.jsonl, one measurement per line, appended by the
# record-sli job in .github/workflows/build.yml.

require 'json'
require 'time'

ROOT = File.expand_path('..', __dir__)
METRICS = File.join(ROOT, 'metrics/provisioning.jsonl')

SLO_SECONDS = Float(ENV.fetch('SLO_SECONDS', '120'))
SLO_TARGET = Float(ENV.fetch('SLO_TARGET', '0.95'))

window_days = nil
if (i = ARGV.index('--window-days'))
  window_days = Integer(ARGV.fetch(i + 1))
end
markdown = ARGV.include?('--markdown')

unless File.exist?(METRICS)
  warn "no measurements yet at #{METRICS}"
  warn 'the record-sli job writes one every time a preview environment comes up'
  exit 0
end

# map/compact rather than filter_map, which needs Ruby 2.7. macOS still ships
# 2.6, and scripts/render-argocd.rb is already held to the same line so that
# `make validate` works on a laptop without a version manager.
samples = File.readlines(METRICS).map do |line|
  line = line.strip
  next nil if line.empty?

  begin
    JSON.parse(line)
  rescue JSON::ParserError
    # One corrupt line should not take the report down with it; a concurrent
    # append is the likely cause and the next run will read it fine.
    warn "skipping unparseable line: #{line[0, 80]}"
    nil
  end
end.compact

if window_days
  cutoff = Time.now - (window_days * 24 * 60 * 60)
  samples.select! do |s|
    begin
      Time.parse(s.fetch('at')) >= cutoff
    rescue ArgumentError, KeyError, TypeError
      false
    end
  end
end

if samples.empty?
  warn 'no measurements in the window'
  exit 0
end

# Nearest-rank, which is the honest one for small samples: it always returns a
# value that was actually observed rather than interpolating between two that
# were.
def percentile(sorted, fraction)
  return nil if sorted.empty?

  rank = (fraction * sorted.length).ceil
  sorted[[rank - 1, 0].max]
end

def summarise(values)
  sorted = values.sort
  {
    count: sorted.length,
    p50: percentile(sorted, 0.50),
    p95: percentile(sorted, 0.95),
    max: sorted.last,
  }
end

by_kind = samples.group_by { |s| s.fetch('kind', 'provision') }
overall = samples.map { |s| s.fetch('seconds') }

# A first provision is the number the promise is about — that is the wait a
# reviewer actually experiences. A redeploy into an environment that already
# exists is a different, faster operation, and averaging the two together
# describes neither.
provisions = (by_kind['provision'] || []).map { |s| s.fetch('seconds') }
judged = provisions.empty? ? overall : provisions

met = judged.count { |s| s <= SLO_SECONDS }
attainment = met.to_f / judged.length
ok = attainment >= SLO_TARGET

# The error budget is what is left of the failures the objective permits. A
# negative one is not a rounding detail: it means the platform is already
# slower than it promised and the next thing to work on is latency.
budget_total = judged.length * (1 - SLO_TARGET)
budget_spent = judged.length - met
budget_left = budget_total - budget_spent

if markdown
  puts "## Provisioning SLO"
  puts
  puts "**Objective:** #{SLO_TARGET * 100}% of preview environments serving within #{SLO_SECONDS.to_i}s of the pull request opening."
  puts
  puts "**Attainment:** #{(attainment * 100).round(1)}% over #{judged.length} first provisions — #{ok ? 'meeting the objective' : 'below the objective'}."
  puts
  puts "Error budget: #{budget_left.round(1)} of #{budget_total.round(1)} remaining."
  puts
  puts '| Operation | Count | p50 | p95 | max |'
  puts '|---|---:|---:|---:|---:|'
  by_kind.sort.each do |kind, rows|
    s = summarise(rows.map { |r| r.fetch('seconds') })
    puts "| #{kind} | #{s[:count]} | #{s[:p50]}s | #{s[:p95]}s | #{s[:max]}s |"
  end
else
  puts "Provisioning SLO: #{SLO_TARGET * 100}% within #{SLO_SECONDS.to_i}s"
  puts
  by_kind.sort.each do |kind, rows|
    s = summarise(rows.map { |r| r.fetch('seconds') })
    puts format('  %-10s n=%-4d p50=%-6s p95=%-6s max=%s',
                kind, s[:count], "#{s[:p50]}s", "#{s[:p95]}s", "#{s[:max]}s")
  end
  puts
  puts "  attainment   #{(attainment * 100).round(1)}% (#{met}/#{judged.length})"
  puts "  error budget #{budget_left.round(1)} of #{budget_total.round(1)} remaining"
  puts
  puts(ok ? 'Meeting the objective.' : 'BELOW the objective.')
end

# Reporting a miss is not the same as failing the build: the number is
# information for whoever is looking, and a scheduled report that goes red on
# a bad week trains people to ignore it. --strict is there for when it should.
exit(1) if ARGV.include?('--strict') && !ok
