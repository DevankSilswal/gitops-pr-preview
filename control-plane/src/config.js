// Configuration, and the refusal to start without it.
//
// Every secret here arrives from the environment, which is populated from a
// Kubernetes Secret the operator creates by hand. None of it is in git, none of
// it is logged, and the process exits rather than starting in a degraded mode
// where an unauthenticated webhook endpoint is reachable from the internet.
//
// That last part is the point. A control plane that starts without a webhook
// secret and merely warns about it is a control plane that will run that way
// for a month.
'use strict';

const fs = require('node:fs');

class ConfigError extends Error {
  constructor(message) { super(message); this.name = 'ConfigError'; }
}

/** Read a value that may be given directly or as a path to a file. */
function fromEnvOrFile(env, name) {
  const direct = env[name];
  const file = env[`${name}_FILE`];
  if (file) {
    try { return fs.readFileSync(file, 'utf8').trim(); }
    catch (err) { throw new ConfigError(`${name}_FILE points at ${file}, which could not be read: ${err.code}`); }
  }
  return direct;
}

function load(env = process.env) {
  const errors = [];
  const require_ = (name, hint) => {
    const value = fromEnvOrFile(env, name);
    if (!value) errors.push(`${name} is not set — ${hint}`);
    return value;
  };

  const cfg = {
    port: Number(env.PORT || 8080),
    databaseFile: env.DATABASE_FILE || '/data/stackpreview.db',
    baseHost: require_('PREVIEW_BASE_HOST',
      'the generated value from deploy/platform-chart/values.yaml, which scripts/sync-base-host.sh writes from Terraform'),

    platformLimits: {
      maxEnvironments: Number(env.MAX_ENVIRONMENTS || 8),
      maxTtlDays: Number(env.MAX_TTL_DAYS || 7),
      // A cluster with no secret salt cannot derive a preview password, so it
      // cannot honour a private preview. This is read from the cluster rather
      // than assumed, and defaults to the safe answer.
      privatePreviewsAvailable: env.PRIVATE_PREVIEWS_AVAILABLE === 'true',
      unknownRepositories: 0,
    },

    github: {
      // Two ways to talk to GitHub, and the choice is a security posture rather
      // than a preference.
      //
      //   app    installation tokens, an hour long, scoped to the repositories
      //          the App was installed on. What this should run as.
      //   token  a personal access token: long-lived, account-scoped, and it
      //          acts as the person who issued it. Weaker, and the only option
      //          that can be set up without a browser — which is why it exists.
      //
      // The webhook path is identical either way: a repository webhook signs
      // with the same HMAC an App does, so nothing about verification changes.
      authMode: (env.GITHUB_AUTH || 'app').toLowerCase(),
      appId: fromEnvOrFile(env, 'GITHUB_APP_ID'),
      privateKey: fromEnvOrFile(env, 'GITHUB_APP_PRIVATE_KEY'),
      token: fromEnvOrFile(env, 'GITHUB_TOKEN'),
      webhookSecret: require_('GITHUB_WEBHOOK_SECRET',
        'the shared secret configured on the App or repository webhook; without it the webhook endpoint has no authentication at all'),
    },

    // Signing key for session cookies. Generated on first start and kept in
    // the database, so restarting does not sign everybody out and nothing has
    // to be committed anywhere.
    sessionKey: fromEnvOrFile(env, 'SESSION_SIGNING_KEY'),

    // Sign-in with GitHub. A separate OAuth App from the credential that talks
    // to repositories: one says who is looking at the dashboard, the other says
    // what the platform may do, and conflating them would hand every visitor
    // the platform's own permissions.
    oauth: {
      clientId: fromEnvOrFile(env, 'GITHUB_OAUTH_CLIENT_ID'),
      clientSecret: fromEnvOrFile(env, 'GITHUB_OAUTH_CLIENT_SECRET'),
      callbackUrl: env.GITHUB_OAUTH_CALLBACK_URL,
    },

    // Public exposure is opt-in and gated on authentication existing. The
    // endpoint is reachable from the internet the moment an Ingress points at
    // it, and a control plane that can create environments must not be.
    exposePublicly: env.EXPOSE_PUBLICLY === 'true',
  };

  if (!['app', 'token'].includes(cfg.github.authMode)) {
    errors.push(`GITHUB_AUTH must be 'app' or 'token', got '${cfg.github.authMode}'`);
  }
  if (cfg.github.authMode === 'app') {
    if (!cfg.github.appId) errors.push('GITHUB_APP_ID is not set — the numeric App ID from the GitHub App settings page');
    if (!cfg.github.privateKey) errors.push('GITHUB_APP_PRIVATE_KEY is not set — mount it as GITHUB_APP_PRIVATE_KEY_FILE rather than an env var');
  }
  if (cfg.github.authMode === 'token' && !cfg.github.token) {
    errors.push('GITHUB_TOKEN is not set — GITHUB_AUTH=token needs one, and it must be able to write labels and comments on the onboarded repositories');
  }

  if (cfg.exposePublicly && !cfg.github.webhookSecret) {
    errors.push('EXPOSE_PUBLICLY is set without GITHUB_WEBHOOK_SECRET — refusing to put an unauthenticated endpoint on the internet');
  }
  if (!Number.isFinite(cfg.port) || cfg.port <= 0) errors.push(`PORT is not a port: ${env.PORT}`);
  if (!Number.isInteger(cfg.platformLimits.maxEnvironments) || cfg.platformLimits.maxEnvironments < 1) {
    errors.push(`MAX_ENVIRONMENTS must be a positive integer, got ${env.MAX_ENVIRONMENTS}`);
  }

  if (errors.length) {
    throw new ConfigError(`the control plane cannot start:\n  - ${errors.join('\n  - ')}`);
  }
  return cfg;
}

/**
 * What may be printed. Used by the startup banner and by nothing else, because
 * the way a secret reaches a log is somebody logging the config object.
 */
function redact(cfg) {
  return {
    port: cfg.port,
    databaseFile: cfg.databaseFile,
    baseHost: cfg.baseHost,
    platformLimits: cfg.platformLimits,
    exposePublicly: cfg.exposePublicly,
    github: {
      authMode: cfg.github.authMode,
      appId: cfg.github.appId || '[absent]',
      privateKey: cfg.github.privateKey ? `[${cfg.github.privateKey.length} bytes]` : '[absent]',
      token: cfg.github.token ? `[${cfg.github.token.length} bytes]` : '[absent]',
      webhookSecret: cfg.github.webhookSecret ? '[set]' : '[absent]',
    },
    oauth: {
      configured: Boolean(cfg.oauth.clientId && cfg.oauth.clientSecret),
      clientId: cfg.oauth.clientId || '[absent]',
      clientSecret: cfg.oauth.clientSecret ? '[set]' : '[absent]',
      callbackUrl: cfg.oauth.callbackUrl || '[absent]',
    },
    sessionKey: cfg.sessionKey ? '[set]' : '[generated at start]',
  };
}

module.exports = { load, redact, ConfigError };
