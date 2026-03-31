#!/bin/bash
# ─────────────────────────────────────────────────────────────
# TênisMatch — Deploy seguro para o VPS
#
# Uso:
#   ./deploy.sh          → deploy normal (preserva dados)
#   ./deploy.sh --migrate → deploy + executa migrações de schema
#   ./deploy.sh --reset   → APAGA O BANCO e recria (CUIDADO!)
# ─────────────────────────────────────────────────────────────

set -e

VPS="root@187.77.144.79"
SSH_KEY="$HOME/.ssh/tennismatch_deploy"
REMOTE_DIR="/opt/tennismatch"
SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=no"

echo "🚀 Iniciando deploy TênisMatch..."

# ── 1. Sincroniza arquivos (nunca o .env do VPS) ─────────────
echo "📦 Enviando arquivos..."
rsync -az --delete \
  -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=no" \
  --exclude='.env' \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='.git' \
  "$(dirname "$0")/" \
  "$VPS:$REMOTE_DIR/"

# ── 2. Build e restart (SEM apagar o banco) ──────────────────
if [ "$1" = "--reset" ]; then
  echo "⚠️  RESET solicitado — banco será APAGADO!"
  read -p "Tem certeza? (digite 'sim' para confirmar): " confirm
  if [ "$confirm" != "sim" ]; then
    echo "Cancelado."
    exit 1
  fi
  $SSH "$VPS" "cd $REMOTE_DIR && docker compose down -v && docker compose up -d --build"
else
  echo "🔨 Rebuilding e reiniciando (dados preservados)..."
  $SSH "$VPS" "cd $REMOTE_DIR && docker compose up -d --build"
fi

# ── 3. Aguarda o app subir ───────────────────────────────────
echo "⏳ Aguardando app iniciar..."
sleep 5

# ── 4. Roda migrações se solicitado ─────────────────────────
if [ "$1" = "--migrate" ]; then
  echo "🗄️  Executando migrações..."
  $SSH "$VPS" "cd $REMOTE_DIR && docker compose exec app node dist/db/migrate.js"
fi

# ── 5. Health check ─────────────────────────────────────────
HEALTH=$($SSH "$VPS" "curl -s http://localhost:3000/health")
echo "✅ Health check: $HEALTH"

echo "🎾 Deploy concluído!"
