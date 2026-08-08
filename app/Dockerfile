# This line is the single source of truth for the Node version. CI reads the
# major out of it with sed to pick the version it tests against, and
# package.json's `engines` states the same floor for anyone running locally.
# Bump it here and both follow.
FROM node:25-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:25-alpine
WORKDIR /app

# Build-time identity, baked into the image by CI. Deploy-time values
# (ENVIRONMENT, PR_NUMBER) are injected by Kubernetes instead.
ARG GIT_SHA=unknown
ARG BUILT_AT=unknown
ENV GIT_SHA=$GIT_SHA
ENV BUILT_AT=$BUILT_AT

# Pick up OS package fixes published since the base image was tagged. This
# trades byte-for-byte reproducibility for patched libraries, which is the
# right way round when the alternative is shipping a known-vulnerable OpenSSL.
RUN apk upgrade --no-cache

# The runtime only ever executes `node server.js`; npm is needed to install
# dependencies, which happens in the deps stage above and is discarded. Its
# large bundled dependency tree was the source of every CRITICAL the image
# scan reported, none of it in code that ever runs.
#
# This does not shrink the image — the files stay in the base layer — but they
# are gone from the final filesystem, so neither the scanner nor anyone who
# gets a shell in a preview environment can reach them.
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/bin/npm \
           /usr/local/bin/npx

# Fixed UID so the Kubernetes securityContext can assert runAsUser without
# depending on whatever id adduser happens to allocate.
RUN addgroup -g 10001 -S appgroup && adduser -u 10001 -S appuser -G appgroup
COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js ./
COPY public ./public
USER appuser
EXPOSE 3000
CMD ["node", "server.js"]
