# No build step and no dependencies — node:sqlite, node:http and node:crypto are
# the whole runtime. The image is the source plus a Node base.
FROM node:24-alpine

# Non-root, and the uid the chart's securityContext expects. A mismatch here
# shows up as a database the process cannot open, several layers from the cause.
RUN addgroup -g 10001 -S app && adduser -u 10001 -S app -G app

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY migrations ./migrations
# The operator scripts run with kubectl exec against this image, so they have to
# be in it. grant-access.js was written for exactly that and then not copied,
# which is the same mistake as the cluster adapter that shelled out to a kubectl
# the image does not contain: written for the container, verified on a laptop.
COPY scripts ./scripts

# The volume is the only writable path; the root filesystem is read-only in the
# pod spec.
RUN mkdir -p /data && chown -R app:app /data /app
USER app

ENV NODE_ENV=production
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--experimental-sqlite", "src/main.js"]
