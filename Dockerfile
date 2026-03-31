# ── Stage 1: build ───────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Stage 2: runtime ─────────────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app

# Apenas dependências de produção
COPY package*.json ./
RUN npm ci --omit=dev

# Copia build gerado
COPY --from=builder /app/dist ./dist

# Copia arquivos estáticos que não passam pelo compilador TypeScript
COPY src/db/schema.sql ./dist/db/schema.sql

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "dist/index.js"]
