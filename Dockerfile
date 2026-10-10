# Multi-stage Dockerfile

# Stage 1: Build Client (Frontend)
FROM node:20-alpine AS client-builder
WORKDIR /app
COPY . .
RUN if [ -d "client" ] && [ -f "client/package.json" ]; then cd client && npm ci && npm run build; else mkdir -p client/dist; fi

# Stage 2: Build Server (Backend)
FROM node:20-alpine AS builder
WORKDIR /app

# Copy server package files
COPY server/package*.json ./server/
WORKDIR /app/server
RUN npm ci

# Copy server source code
COPY server/ ./
RUN npm run build

# Stage 3: Production Runner
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
WORKDIR /app/server

COPY --from=builder /app/server/package*.json ./
RUN npm ci --only=production

COPY --from=builder /app/server/dist ./dist
COPY --from=builder /app/server/server.js ./server.js

# Copy built frontend assets into server public folder
COPY --from=client-builder /app/client/dist ./public

EXPOSE 5000
CMD ["node", "server.js"]