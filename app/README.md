# preview-app

A deliberately minimal Express app. Its only purpose is to be a realistic thing to deploy — it exists so the GitOps/PR-preview platform has something concrete to build, ship, and tear down per pull request.

It reports its own build identity so you can visually confirm which PR/commit a given preview environment is running:

- `GET /` — HTML page showing environment, PR number, git SHA, build time
- `GET /api/health` — liveness/readiness check
- `GET /api/info` — same build info as JSON

All values come from env vars (`ENVIRONMENT`, `PR_NUMBER`, `GIT_SHA`, `BUILT_AT`), set by CI/CD and Kubernetes manifests in later phases.

## Local dev

```
npm install
npm test
npm start
```

## Docker

```
docker build -t preview-app .
docker run -p 3000:3000 -e PR_NUMBER=42 -e GIT_SHA=abc123 preview-app
```

## Live

This application is deployed by the platform in this repository.
