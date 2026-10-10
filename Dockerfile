# syntax=docker/dockerfile:1

# ---- client: static build ----
FROM node:22-alpine AS client
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# ---- server: compile TypeScript ----
FROM node:22-alpine AS server
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci
COPY server/ ./
RUN npm run build

# ---- runtime: production deps only, non-root ----
FROM node:22-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=server /app/server/dist ./dist
# the API serves the SPA from dist/public (see src/app.ts)
COPY --from=client /app/client/dist ./dist/public
USER node
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:5000/api/health || exit 1
CMD ["node", "dist/server.js"]
