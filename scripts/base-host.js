// One implementation of "what hostname does this cluster answer on".
//
// The rule is small enough that it was written four times — in
// bootstrap-cluster.sh, in Terraform's preview_url_pattern output, in a
// repository variable somebody set by hand, and in the platform chart's values
// — and a rule written four times is a rule with four opportunities to disagree
// the day the VM is replaced.
//
// nip.io resolves both `1.2.3.4.nip.io` and `1-2-3-4.nip.io`, and this platform
// needs the dashed form specifically: the address always follows a label like
// `pr-1`, and nip.io splits on dashes as well as dots when it looks for an
// address, so `pr-1.1.2.3.4.nip.io` is misread as the address `1.127.0.0`. That
// bug cost an afternoon once and is the entire reason this conversion exists
// rather than string concatenation at each call site.
'use strict';

/**
 * Turn an IPv4 address into the base hostname every preview URL hangs off.
 *
 * Throws rather than returning a fallback. A fallback here would be a
 * production IP baked into a function whose whole purpose is not having one:
 * the caller would get a working hostname for the wrong cluster and no
 * indication anything was wrong, which is worse than a crash during bootstrap.
 */
function baseHostFromIp(ip) {
  if (ip === undefined || ip === null) throw new Error('no IP given');
  if (typeof ip !== 'string') throw new Error(`IP must be a string, got ${typeof ip}`);

  // Whitespace is tolerated because the usual source is `terraform output`,
  // which ends in a newline often enough that trimming here is kinder than a
  // confusing failure two layers away.
  const trimmed = ip.trim();
  if (trimmed === '') throw new Error('IP is empty');

  const octets = trimmed.split('.');
  if (octets.length !== 4) {
    throw new Error(`not an IPv4 address: ${JSON.stringify(trimmed)} — this platform derives its hostnames from nip.io, which is IPv4 only`);
  }
  for (const octet of octets) {
    if (!/^\d{1,3}$/.test(octet)) throw new Error(`not an IPv4 address: ${JSON.stringify(trimmed)}`);
    const n = Number(octet);
    if (n > 255) throw new Error(`octet out of range in ${JSON.stringify(trimmed)}: ${octet}`);
    // 010 is not 10 to everything that parses addresses, and the ambiguity has
    // no upside here.
    if (octet.length > 1 && octet[0] === '0') throw new Error(`leading zero in ${JSON.stringify(trimmed)}: ${octet}`);
  }

  return `${octets.join('-')}.nip.io`;
}

/** Where a named environment answers, given the cluster's base hostname. */
function hostFor(name, baseHost) {
  if (!baseHost) throw new Error('no base host given');
  return `${name}.${baseHost}`;
}

module.exports = { baseHostFromIp, hostFor };

// Used as a command by scripts/sync-base-host.sh and by bootstrap, so there is
// exactly one conversion in the repository rather than a sed expression per
// caller.
if (require.main === module) {
  try {
    process.stdout.write(baseHostFromIp(process.argv[2]) + '\n');
  } catch (err) {
    process.stderr.write(`base-host: ${err.message}\n`);
    process.exit(1);
  }
}
