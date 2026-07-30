FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-alpine
WORKDIR /app

# Build-time identity, baked into the image by CI. Deploy-time values
# (ENVIRONMENT, PR_NUMBER) are injected by Kubernetes instead.
ARG GIT_SHA=unknown
ARG BUILT_AT=unknown
ENV GIT_SHA=$GIT_SHA
ENV BUILT_AT=$BUILT_AT

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js ./
USER appuser
EXPOSE 3000
CMD ["node", "server.js"]
