# The Flow server image. Flow Release Publish (.github/workflows/
# flow-release-publish.yml) builds it for each release, and CI's docker-build
# lane builds and smokes it on every change. Configure it with environment
# variables (docs/SELF_HOSTING.md); DATABASE_URL is required.
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ARG VCS_REF=unknown
LABEL org.opencontainers.image.revision="${VCS_REF}"
ENV FLOW_REVISION="${VCS_REF}"
# The release tag a release image is (Flow Release Publish sets it), or empty.
ARG FLOW_RELEASE=""
ENV FLOW_RELEASE="${FLOW_RELEASE}"
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
# The code is read only; the server keeps its records in PostgreSQL.
RUN chown -R root:root /app \
  && find /app -type d -exec chmod 0555 {} + \
  && find /app -type f -exec chmod 0444 {} +
USER node
EXPOSE 19300
CMD ["node", "server/index.js"]
