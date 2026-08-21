#!/usr/bin/env node
// Give a person access to the dashboard, from inside the cluster.
//
//   kubectl exec -n stackpreview deploy/stackpreview-control-plane -- \
//     node /app/scripts/grant-access.js <github-login> [owner|admin|developer|viewer]
//
// Two things need to exist before anybody can sign in: a user row for the
// GitHub account, and a membership saying what they may do. OAuth creates the
// first on its own and cannot create the second — there is no answer to "what
// role should a stranger have" that is safe to guess, so the first membership
// is always granted by somebody with access to the cluster.
//
// It also prints a one-time sign-in link. That exists so the dashboard can be
// reached before an OAuth App is registered, which is the state this
// installation is in: the session it issues is the same signed, revocable,
// HttpOnly session OAuth would produce, and it expires in an hour.
'use strict';

const crypto = require('node:crypto');
const st = require('../src/persistence/store.js');
const { SessionService } = require('../src/auth/session.js');

async function main() {
  const [login, role = 'owner'] = process.argv.slice(2);
  if (!login) throw new Error('usage: grant-access.js <github-login> [owner|admin|developer|viewer]');
  if (!['owner', 'admin', 'developer', 'viewer'].includes(role)) throw new Error(`unknown role: ${role}`);

  const db = st.open(process.env.DATABASE_FILE || '/data/stackpreview.db');
  st.migrate(db);
  const store = st.createStore(db);

  // The GitHub id is the identity that survives a rename, so it is looked up
  // rather than trusted from the argument.
  const res = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'stackpreview' },
  });
  if (!res.ok) throw new Error(`GitHub does not know a user called ${login} (${res.status})`);
  const gh = await res.json();

  const user = store.upsertUser({ githubId: gh.id, login: gh.login, avatarUrl: gh.avatar_url });

  const orgs = db.prepare('SELECT * FROM organizations').all();
  if (!orgs.length) throw new Error('there are no organizations yet; connect a repository first');

  for (const org of orgs) {
    const existing = db.prepare('SELECT * FROM memberships WHERE organization_id = ? AND user_id = ?')
      .get(org.id, user.id);
    if (existing) {
      db.prepare('UPDATE memberships SET role = ? WHERE id = ?').run(role, existing.id);
      console.log(`  ${gh.login} is now ${role} of ${org.name}`);
    } else {
      store.addMembership({ organizationId: org.id, userId: user.id, role });
      console.log(`  ${gh.login} granted ${role} of ${org.name}`);
    }
  }

  store.recordAudit({
    organizationId: orgs[0].id, actorUserId: null, action: 'membership.granted',
    subjectType: 'user', subjectId: user.id, detail: { login: gh.login, role },
  });

  const signingKey = process.env.SESSION_SIGNING_KEY
    || store.getOrCreateSetting('session_signing_key', () => crypto.randomBytes(32).toString('base64url'));
  const sessions = new SessionService({ store, signingKey, ttlHours: 1 });
  const session = sessions.issue(user.id);

  console.log('');
  console.log('  A one-hour session, for reaching the dashboard before GitHub sign-in is set up.');
  console.log('  Paste this in the browser console on the dashboard origin, then reload:');
  console.log('');
  console.log(`    document.cookie = "stackpreview_session=${session.value}; path=/; SameSite=Lax; Secure"`);
  console.log('');
  console.log('  Revoke it by signing out, or by deleting the row from sessions.');
}

main().catch((err) => { console.error(String(err.message)); process.exit(1); });
