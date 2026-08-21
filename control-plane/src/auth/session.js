// Sessions: a signed identifier in a cookie, and a row that can be revoked.
//
// The cookie carries no identity of its own. It carries an id and a signature
// over that id, and everything about who the user is comes from the row it
// points at — so revoking a session is a delete, not a wait for an expiry
// somebody else controls. A self-contained token would have been less code and
// would have made "sign this person out now" impossible to answer honestly.
'use strict';

const crypto = require('node:crypto');

const COOKIE = 'stackpreview_session';
const DEFAULT_TTL_HOURS = 12;

class SessionService {
  /**
   * @param {object} deps
   * @param {string} deps.signingKey  generated at first start, never in git
   * @param {boolean} deps.secureCookies  false only for local http development
   */
  constructor({ store, signingKey, secureCookies = true, ttlHours = DEFAULT_TTL_HOURS }) {
    if (!signingKey || signingKey.length < 32) {
      throw new Error('the session signing key must be at least 32 characters');
    }
    this.store = store;
    this.signingKey = signingKey;
    this.secureCookies = secureCookies;
    this.ttlHours = ttlHours;
  }

  #sign(id) {
    return crypto.createHmac('sha256', this.signingKey).update(id).digest('base64url');
  }

  /** Timing-safe, because comparing signatures with === leaks their prefix. */
  #verify(id, signature) {
    const expected = this.#sign(id);
    const a = Buffer.from(expected);
    const b = Buffer.from(String(signature || ''));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  issue(userId) {
    const id = crypto.randomBytes(24).toString('base64url');
    const now = Date.now();
    const expiresAt = new Date(now + this.ttlHours * 3600_000).toISOString();
    this.store.createSession({ id, userId, expiresAt });
    return { id, value: `${id}.${this.#sign(id)}`, expiresAt };
  }

  /** @returns {{userId: string}|null} */
  resolve(cookieValue) {
    if (!cookieValue || typeof cookieValue !== 'string') return null;
    const dot = cookieValue.lastIndexOf('.');
    if (dot < 1) return null;
    const id = cookieValue.slice(0, dot);
    if (!this.#verify(id, cookieValue.slice(dot + 1))) return null;

    const row = this.store.getSession(id);
    if (!row) return null;
    if (Date.parse(row.expires_at) <= Date.now()) {
      // Expired sessions are removed on sight rather than swept: the table only
      // grows otherwise, and the row is worthless the moment it is read.
      this.store.deleteSession(id);
      return null;
    }
    return { userId: row.user_id, sessionId: id };
  }

  revoke(cookieValue) {
    const dot = String(cookieValue || '').lastIndexOf('.');
    if (dot < 1) return false;
    const id = cookieValue.slice(0, dot);
    if (!this.#verify(id, cookieValue.slice(dot + 1))) return false;
    this.store.deleteSession(id);
    return true;
  }

  cookie(value, { maxAgeSeconds } = {}) {
    const parts = [
      `${COOKIE}=${value}`,
      'Path=/',
      // HttpOnly: no script can read it, so an XSS in the dashboard cannot
      // exfiltrate a session. SameSite=Lax: the OAuth callback is a top-level
      // navigation and needs the cookie to survive it; Strict would break it.
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${maxAgeSeconds ?? this.ttlHours * 3600}`,
    ];
    if (this.secureCookies) parts.push('Secure');
    return parts.join('; ');
  }

  clearCookie() { return this.cookie('', { maxAgeSeconds: 0 }); }

  static parse(header) {
    const out = {};
    for (const part of String(header || '').split(';')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
    return out[COOKIE] || null;
  }
}

module.exports = { SessionService, COOKIE };
