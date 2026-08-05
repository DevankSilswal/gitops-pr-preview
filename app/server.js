const path = require('node:path');
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

// The site is static; only its identity changes between environments, and the
// page asks for that at runtime. Serving the same bytes everywhere means a
// preview shows the build that was actually published, not one re-rendered for
// the occasion.
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/info', (req, res) => {
  res.json(buildInfo());
});

if (require.main === module) {
  const server = app.listen(port, () => {
    console.log(`pixel-arcade listening on port ${port}`);
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
