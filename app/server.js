const express = require('express');

const app = express();
const port = process.env.PORT || 3000;

function buildInfo() {
  return {
    environment: process.env.ENVIRONMENT || 'local',
    prNumber: process.env.PR_NUMBER || 'none',
    gitSha: process.env.GIT_SHA || 'unknown',
    builtAt: process.env.BUILT_AT || 'unknown',
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

app.get('/', (req, res) => {
  const info = buildInfo();
  res.type('html').send(`<!doctype html>
<html>
  <head><title>Preview Environment</title></head>
  <body style="font-family: sans-serif; padding: 2rem;">
    <h1>Preview Environment &mdash; ${escapeHtml(info.environment)}</h1>
    <ul>
      <li><strong>Environment:</strong> ${escapeHtml(info.environment)}</li>
      <li><strong>PR Number:</strong> ${escapeHtml(info.prNumber)}</li>
      <li><strong>Git SHA:</strong> ${escapeHtml(info.gitSha)}</li>
      <li><strong>Built At:</strong> ${escapeHtml(info.builtAt)}</li>
    </ul>
  </body>
</html>`);
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/info', (req, res) => {
  res.json(buildInfo());
});

if (require.main === module) {
  const server = app.listen(port, () => {
    console.log(`preview-app listening on port ${port}`);
  });

  // Kubernetes sends SIGTERM before removing a pod. Preview environments are
  // created and destroyed constantly, so shut down cleanly instead of being
  // killed after the grace period expires.
  const shutdown = (signal) => {
    console.log(`received ${signal}, shutting down`);
    server.close(() => process.exit(0));
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = app;
