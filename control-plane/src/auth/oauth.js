// Sign in with GitHub.
//
// A separate OAuth App rather than the GitHub App that talks to repositories.
// They answer different questions: the App's installation token says what the
// platform may do to a repository, and says nothing about who is looking at the
// dashboard. Reusing it for sign-in would mean every visitor inherited the
// platform's own permissions, which is the opposite of an authorization
// boundary.
//
// The client secret never leaves the server and no GitHub token is ever handed
// to the browser: the token is used once, server-side, to learn who the user is,
// and then discarded. What the browser gets is a session id for a row in this
// database.
'use strict';

const crypto = require('node:crypto');

const AUTHORIZE = 'https://github.com/login/oauth/authorize';
const TOKEN = 'https://github.com/login/oauth/access_token';
const API = 'https://api.github.com';
const STATE_COOKIE = 'stackpreview_oauth_state';

class OAuthService {
  constructor({ clientId, clientSecret, callbackUrl, secureCookies = true }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.callbackUrl = callbackUrl;
    this.secureCookies = secureCookies;
  }

  static configured(cfg) { return Boolean(cfg && cfg.clientId && cfg.clientSecret); }

  /**
   * The state parameter is CSRF protection and nothing else works in its place.
   * Without it an attacker can complete a login flow in the victim's browser
   * and leave them signed in as the attacker — which sounds harmless until the
   * victim's next action happens in the attacker's account.
   */
  begin() {
    const state = crypto.randomBytes(24).toString('base64url');
    const url = new URL(AUTHORIZE);
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('redirect_uri', this.callbackUrl);
    // read:user is enough to learn who someone is. Anything wider would be
    // asking for access this product has no use for.
    url.searchParams.set('scope', 'read:user');
    url.searchParams.set('state', state);
    return { url: url.toString(), state, cookie: this.#stateCookie(state) };
  }

  #stateCookie(value, maxAge = 600) {
    const parts = [`${STATE_COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
    if (this.secureCookies) parts.push('Secure');
    return parts.join('; ');
  }

  clearStateCookie() { return this.#stateCookie('', 0); }

  static readState(cookieHeader) {
    for (const part of String(cookieHeader || '').split(';')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      if (part.slice(0, eq).trim() === STATE_COOKIE) return part.slice(eq + 1).trim();
    }
    return null;
  }

  /** Constant-time, because a state comparison is a secret comparison. */
  static stateMatches(fromQuery, fromCookie) {
    if (!fromQuery || !fromCookie) return false;
    const a = Buffer.from(String(fromQuery));
    const b = Buffer.from(String(fromCookie));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  /** Exchange the code for a token, use it once, and do not keep it. */
  async identify(code) {
    const res = await fetch(TOKEN, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code,
        redirect_uri: this.callbackUrl,
      }),
    });
    if (!res.ok) throw new Error(`GitHub refused the code exchange: ${res.status}`);
    const body = await res.json();
    if (body.error) throw new Error(`GitHub refused the code exchange: ${body.error}`);
    const token = body.access_token;
    if (!token) throw new Error('GitHub returned no access token');

    const who = await fetch(`${API}/user`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json',
        'user-agent': 'stackpreview' },
    });
    if (!who.ok) throw new Error(`could not read the GitHub identity: ${who.status}`);
    const user = await who.json();
    // The token is not returned, not stored and not logged. Its entire purpose
    // was this one question.
    return { githubId: user.id, login: user.login, avatarUrl: user.avatar_url };
  }
}

module.exports = { OAuthService, STATE_COOKIE };
