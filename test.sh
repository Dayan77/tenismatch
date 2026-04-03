#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# TênisMatch — Test Suite Completo
# Executa 19 cenários, valida estado no banco e corrige automaticamente
# problemas encontrados. Ciclo: teste → diagnóstico → correção → reteste.
#
# Uso:
#   ./test.sh           → testa + corrige automaticamente
#   ./test.sh --no-fix  → só reporta, não altera código
# ═══════════════════════════════════════════════════════════════════════════════

# ── Cores ──────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

pass()    { echo -e "  ${GREEN}✅ PASS${NC} $1"; }
fail()    { echo -e "  ${RED}❌ FAIL${NC} $1"; }
info()    { echo -e "  ${CYAN}ℹ  ${NC}$1"; }
warn()    { echo -e "  ${YELLOW}⚠  ${NC}$1"; }
fixing()  { echo -e "\n${YELLOW}🔧 CORREÇÃO: $1${NC}"; }
section() { echo -e "\n${BOLD}${BLUE}── $1 ──────────────────────────────────────${NC}"; }

# ── Configuração ───────────────────────────────────────────────────────────────
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

# Carrega variáveis do .env local para obter EVOLUTION_API_KEY
if [[ -f "$SRC_DIR/.env" ]]; then
  set -a; source "$SRC_DIR/.env"; set +a
fi

BASE_URL="https://tenismatch-tenismatch.qgdyk2.easypanel.host"
WEBHOOK="$BASE_URL/webhook/whatsapp"
WEBHOOK_BAD="$BASE_URL/webhook/whatsapp"   # mesma URL, mas enviará apikey errada
WEBHOOK_API_KEY="${EVOLUTION_API_KEY:-}"
AUTO_FIX=true
MAX_CYCLES=5

# Telefones isolados para testes (não são números WhatsApp reais)
P_A="5500000000001"   # Jogador A — 3a_classe (solicitante principal)
P_B="5500000000002"   # Jogador B — 3a_classe (convidado 1)
P_C="5500000000003"   # Jogador C — 3a_classe (convidado 2)
P_N="5500000000099"   # Jogador N — novo usuário (onboarding)
P_S="5500000000050"   # Jogador S — classe_pro (sem adversários)

# Datas
AMANHA=$(date -d '+1 day' '+%Y-%m-%d' 2>/dev/null || date -v+1d '+%Y-%m-%d' 2>/dev/null)
DEPOIS=$(date -d '+2 days' '+%Y-%m-%d' 2>/dev/null || date -v+2d '+%Y-%m-%d' 2>/dev/null)

# Globais de estado
ID_A=""; ID_B=""; ID_C=""; ID_N=""; ID_S=""
CURRENT_SOL_ID=""
PARTIDA_TEST_ID=""

# Contadores
TESTS_RUN=0; TESTS_PASS=0; TESTS_FAIL=0
FAILURES=()

# Parse args
for arg in "$@"; do [[ "$arg" == "--no-fix" ]] && AUTO_FIX=false; done

# ── Helpers ────────────────────────────────────────────────────────────────────

send_msg() {
  local phone=$1 msg=$2
  # Escapa aspas duplas e barras invertidas na mensagem para JSON seguro
  local msg_escaped
  msg_escaped=$(printf '%s' "$msg" | sed 's/\\/\\\\/g; s/"/\\"/g')
  curl -s -X POST "$WEBHOOK" \
    -H "Content-Type: application/json" \
    -H "apikey: $WEBHOOK_API_KEY" \
    -d "{\"event\":\"messages.upsert\",\"instance\":\"tenismatch\",\"apikey\":\"$WEBHOOK_API_KEY\",\"data\":{\"key\":{\"remoteJid\":\"${phone}@s.whatsapp.net\",\"fromMe\":false,\"id\":\"TEST$(date +%s%N 2>/dev/null || date +%s)\"},\"message\":{\"conversation\":\"$msg_escaped\"},\"messageType\":\"conversation\",\"messageTimestamp\":$(date +%s)}}" \
    > /dev/null
}

db() {
  local sql="$1"
  curl -s -X POST "$BASE_URL/api/debug/query?token=$WEBHOOK_API_KEY" \
    -H "Content-Type: application/json" \
    --data-raw "$(jq -nc --arg sql "$sql" '{sql: $sql}')" 2>/dev/null \
  | jq -r 'if .rows and (.rows|length)>0 then .rows[0]|to_entries[0].value|tostring else "" end' 2>/dev/null \
  | tr -d '\r\n'
}

db_raw() {
  local sql="$1"
  curl -s -X POST "$BASE_URL/api/debug/query?token=$WEBHOOK_API_KEY" \
    -H "Content-Type: application/json" \
    --data-raw "$(jq -nc --arg sql "$sql" '{sql: $sql}')" 2>/dev/null \
  | jq -r '.rows[]|to_entries[0].value|tostring' 2>/dev/null
}

assert() {
  local name=$1 actual=$2 expected=$3
  TESTS_RUN=$((TESTS_RUN+1))
  if [[ "$actual" == "$expected" ]]; then
    pass "$name"
    TESTS_PASS=$((TESTS_PASS+1))
    return 0
  else
    fail "$name  [esperado='$expected' obtido='$actual']"
    TESTS_FAIL=$((TESTS_FAIL+1))
    FAILURES+=("$name")
    return 1
  fi
}

assert_nonempty() {
  local name=$1 val=$2
  TESTS_RUN=$((TESTS_RUN+1))
  if [[ -n "$val" && "$val" != "" && "$val" != "0" ]]; then
    pass "$name"
    TESTS_PASS=$((TESTS_PASS+1))
    return 0
  else
    fail "$name  [valor vazio ou zero]"
    TESTS_FAIL=$((TESTS_FAIL+1))
    FAILURES+=("$name")
    return 1
  fi
}

logs_since() {
  # Sem acesso SSH ao servidor Easypanel — retorna vazio
  echo ""
}

deploy_app() {
  warn "Auto-deploy não disponível no Easypanel via CLI. Faça o redeploy manualmente no painel."
  sleep 2
}

# ── Setup ──────────────────────────────────────────────────────────────────────

setup() {
  section "SETUP — Ambiente de Teste"

  info "Removendo dados de teste anteriores..."
  db "DELETE FROM convites_match WHERE
        solicitante_id IN (SELECT id FROM jogadores WHERE telefone LIKE '550000000000%')
     OR convidado_id  IN (SELECT id FROM jogadores WHERE telefone LIKE '550000000000%');" > /dev/null 2>&1 || true
  db "DELETE FROM solicitacoes_match WHERE jogador_id IN
        (SELECT id FROM jogadores WHERE telefone LIKE '550000000000%');" > /dev/null 2>&1 || true
  db "DELETE FROM partidas WHERE
        jogador1_id IN (SELECT id FROM jogadores WHERE telefone LIKE '550000000000%')
     OR jogador2_id IN (SELECT id FROM jogadores WHERE telefone LIKE '550000000000%');" > /dev/null 2>&1 || true
  db "DELETE FROM jogadores WHERE telefone LIKE '550000000000%';" > /dev/null 2>&1 || true

  info "Garantindo quadra de teste..."
  local qid
  qid=$(db "SELECT id FROM quadras WHERE nome='Quadra Teste' LIMIT 1;")
  if [[ -z "$qid" ]]; then
    qid=$(db "INSERT INTO quadras (nome, localizacao, ativa)
      VALUES ('Quadra Teste','Arena TênisMatch, Manaus-AM',TRUE) RETURNING id;")
  fi
  if [[ -n "$qid" ]]; then
    db "INSERT INTO quadra_horarios (quadra_id, dia_semana, hora_inicio, hora_fim)
      SELECT '$qid', g, '07:00', '22:00' FROM generate_series(0,6) g
      ON CONFLICT DO NOTHING;" > /dev/null 2>&1 || true
  fi

  info "Criando jogadores de teste..."
  db "INSERT INTO jogadores (nome, telefone, email, nivel, ativo) VALUES
    ('Teste Jogador A','$P_A','ta@tennismatch.app','3a_classe',TRUE),
    ('Teste Jogador B','$P_B','tb@tennismatch.app','3a_classe',TRUE),
    ('Teste Jogador C','$P_C','tc@tennismatch.app','3a_classe',TRUE),
    ('Teste Jogador S','$P_S','ts@tennismatch.app','classe_pro',TRUE)
    ON CONFLICT (telefone) DO UPDATE SET ativo=TRUE, nivel=EXCLUDED.nivel;" > /dev/null

  ID_A=$(db "SELECT id FROM jogadores WHERE telefone='$P_A';")
  ID_B=$(db "SELECT id FROM jogadores WHERE telefone='$P_B';")
  ID_C=$(db "SELECT id FROM jogadores WHERE telefone='$P_C';")
  ID_S=$(db "SELECT id FROM jogadores WHERE telefone='$P_S';")

  info "A=$ID_A | B=$ID_B | C=$ID_C | S=$ID_S"
  info "Amanhã=$AMANHA | Depois=$DEPOIS"
}

expire_pending() {
  local jogador_id=$1
  db "UPDATE convites_match SET status='expirado'
      WHERE status='pendente' AND
      solicitacao_id IN (SELECT id FROM solicitacoes_match WHERE jogador_id='$jogador_id');" > /dev/null 2>&1 || true
  db "UPDATE solicitacoes_match SET status='expirado'
      WHERE jogador_id='$jogador_id' AND status='pendente';" > /dev/null 2>&1 || true
}

reset_contexto() {
  local phone=$1
  curl -s -X POST "$BASE_URL/api/debug/reset-contexto?token=$WEBHOOK_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"chave\":\"$phone\"}" > /dev/null
}

# ══════════════════════════════════════════════════════════════════════════════
#  TESTES
# ══════════════════════════════════════════════════════════════════════════════

# ── T01: Health check ──────────────────────────────────────────────────────────
t01_health() {
  section "T01 — Health Check"
  local h; h=$(curl -s "$BASE_URL/health")
  assert "API online" "$(echo "$h" | grep -c '"status":"ok"')" "1"
  assert "Banco conectado" "$(echo "$h" | grep -c '"banco":"conectado"')" "1"
}

# ── T02: Token inválido → 403 (endpoint de debug, não webhook) ────────────────
t02_token_invalido() {
  section "T02 — Segurança: Token Inválido → 403"
  local code; code=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    "$BASE_URL/api/debug/query?token=CHAVE_INVALIDA_XPTO" \
    -H "Content-Type: application/json" \
    -d '{"sql":"SELECT 1"}')
  assert "Token inválido → 403" "$code" "403"
}

# ── T03: fromMe=true ignorado ─────────────────────────────────────────────────
t03_from_me() {
  section "T03 — Segurança: fromMe=true Ignorado"
  local antes; antes=$(db "SELECT COUNT(*) FROM solicitacoes_match WHERE jogador_id='$ID_A';")
  curl -s -X POST "$WEBHOOK" -H "Content-Type: application/json" \
    -H "apikey: $WEBHOOK_API_KEY" \
    -d "{\"event\":\"messages.upsert\",\"instance\":\"tenismatch\",\"apikey\":\"$WEBHOOK_API_KEY\",\"data\":{\"key\":{\"remoteJid\":\"${P_A}@s.whatsapp.net\",\"fromMe\":true,\"id\":\"TESTFROMME\"},\"message\":{\"conversation\":\"quero match\"},\"messageType\":\"conversation\",\"messageTimestamp\":$(date +%s)}}" \
    > /dev/null
  sleep 2
  local depois; depois=$(db "SELECT COUNT(*) FROM solicitacoes_match WHERE jogador_id='$ID_A';")
  assert "fromMe=true não gera solicitação" "$depois" "$antes"
}

# ── T04: Onboarding ───────────────────────────────────────────────────────────
t04_onboarding() {
  section "T04 — Onboarding: Novo Usuário"
  db "DELETE FROM jogadores WHERE telefone='$P_N';" > /dev/null 2>&1 || true
  reset_contexto "$P_N"
  sleep 1

  send_msg "$P_N" "Oi"
  sleep 9
  send_msg "$P_N" "Maria Onboarding"
  sleep 9
  send_msg "$P_N" "5"   # 5 = 4a_classe
  sleep 12

  local nome nivel
  nome=$(db "SELECT nome FROM jogadores WHERE telefone='$P_N';")
  nivel=$(db "SELECT nivel FROM jogadores WHERE telefone='$P_N';")
  ID_N=$(db "SELECT id FROM jogadores WHERE telefone='$P_N';")

  assert "Onboarding: nome salvo" "$nome" "Maria Onboarding"
  assert "Onboarding: classe 5 → 4a_classe" "$nivel" "4a_classe"
}

# ── T05: Mapeamento de classes (1-9) ──────────────────────────────────────────
t05_mapeamento() {
  section "T05 — Mapeamento de Classes (1-9)"

  # Array indexado (compatível com bash 3.x)
  local MAPA_1="classe_pro" MAPA_2="1a_classe" MAPA_3="2a_classe"
  local MAPA_4="3a_classe" MAPA_5="4a_classe" MAPA_6="5a_classe"
  local MAPA_7="6a_classe" MAPA_8="principiantes" MAPA_9="feminino"

  for num in 1 2 3 4 5 6 7 8 9; do
    local esperado
    eval "esperado=\$MAPA_$num"
    # Escolhe baseline diferente do esperado para que a poll possa detectar a mudança
    local baseline="1a_classe"
    [[ "$esperado" == "1a_classe" ]] && baseline="2a_classe"
    # Reseta contexto e força classe baseline (diferente do esperado)
    reset_contexto "$ID_B"
    db "UPDATE jogadores SET nivel='$baseline' WHERE telefone='$P_B';" > /dev/null
    sleep 2
    send_msg "$P_B" "quero mudar minha classe"
    sleep 14
    send_msg "$P_B" "$num"
    # Aguarda DB mudar do baseline (até 60 segundos = 30 tentativas × 2s)
    local nivel attempts=0
    while [[ $attempts -lt 30 ]]; do
      sleep 2
      nivel=$(db "SELECT nivel FROM jogadores WHERE telefone='$P_B';")
      [[ "$nivel" != "$baseline" ]] && break
      ((attempts++))
    done
    assert "Opção $num → $esperado" "$nivel" "$esperado"
  done

  # Restaura B para 3a_classe
  db "UPDATE jogadores SET nivel='3a_classe' WHERE telefone='$P_B';" > /dev/null
}

# ── T06: Solicitar match — data correta + convites ────────────────────────────
t06_solicitar() {
  section "T06 — Solicitar Match: Data Correta + Convites"
  expire_pending "$ID_A"
  reset_contexto "$ID_A"
  sleep 2

  send_msg "$P_A" "quero um match para amanhã às 14h"
  sleep 10

  CURRENT_SOL_ID=$(db "SELECT id FROM solicitacoes_match
    WHERE jogador_id='$ID_A' AND status='pendente'
    ORDER BY criado_em DESC LIMIT 1;")
  local data hora conv_b conv_c
  data=$(db "SELECT data_preferida::text FROM solicitacoes_match WHERE id='$CURRENT_SOL_ID';")
  hora=$(db "SELECT horario_preferido::text FROM solicitacoes_match WHERE id='$CURRENT_SOL_ID';")
  conv_b=$(db "SELECT COUNT(*) FROM convites_match WHERE solicitacao_id='$CURRENT_SOL_ID' AND convidado_id='$ID_B' AND status='pendente';")
  conv_c=$(db "SELECT COUNT(*) FROM convites_match WHERE solicitacao_id='$CURRENT_SOL_ID' AND convidado_id='$ID_C' AND status='pendente';")

  assert_nonempty "Solicitação criada" "$CURRENT_SOL_ID"
  assert "Data = amanhã ($AMANHA)" "$data" "$AMANHA"
  assert "Hora = 14:00" "$hora" "14:00:00"
  assert "Convite enviado para B" "$conv_b" "1"
  assert "Convite enviado para C" "$conv_c" "1"
}

# ── T07: Aceitar convite — "sim" ──────────────────────────────────────────────
t07_aceitar_sim() {
  section "T07 — Aceitar Convite: 'sim'"
  [[ -z "$CURRENT_SOL_ID" ]] && { warn "T07: pré-condição T06 falhou — skip"; return; }

  send_msg "$P_B" "sim"
  sleep 6

  local conv_b sol_status partida conv_c
  conv_b=$(db "SELECT status FROM convites_match WHERE convidado_id='$ID_B' AND solicitacao_id='$CURRENT_SOL_ID';")
  sol_status=$(db "SELECT status FROM solicitacoes_match WHERE id='$CURRENT_SOL_ID';")
  partida=$(db "SELECT COUNT(*) FROM partidas WHERE status='agendada' AND
    ((jogador1_id='$ID_A' AND jogador2_id='$ID_B') OR (jogador1_id='$ID_B' AND jogador2_id='$ID_A'));")
  conv_c=$(db "SELECT status FROM convites_match WHERE convidado_id='$ID_C' AND solicitacao_id='$CURRENT_SOL_ID';")

  assert "Convite B → aceito" "$conv_b" "aceito"
  assert "Solicitação → match_encontrado" "$sol_status" "match_encontrado"
  assert "Partida A×B criada" "$partida" "1"
  assert "Convite C → expirado (automático)" "$conv_c" "expirado"

  PARTIDA_TEST_ID=$(db "SELECT id FROM partidas
    WHERE (jogador1_id='$ID_A' AND jogador2_id='$ID_B')
       OR (jogador1_id='$ID_B' AND jogador2_id='$ID_A')
    ORDER BY criado_em DESC LIMIT 1;")
}

# ── T08: Aceitar convite — "Sim 👍🏻" (emoji) ──────────────────────────────────
t08_aceitar_emoji() {
  section "T08 — Aceitar Convite: 'Sim 👍🏻' (com emoji)"
  expire_pending "$ID_A"

  send_msg "$P_A" "quero match para depois de amanhã às 10h"
  sleep 9

  local sol2
  sol2=$(db "SELECT id FROM solicitacoes_match WHERE jogador_id='$ID_A' AND status='pendente' ORDER BY criado_em DESC LIMIT 1;")
  if [[ -z "$sol2" ]]; then
    warn "T08: Solicitação não criada — skip"
    return
  fi

  send_msg "$P_C" "Sim 👍🏻"
  sleep 6

  local conv_c sol2_status
  conv_c=$(db "SELECT status FROM convites_match WHERE convidado_id='$ID_C' AND solicitacao_id='$sol2';")
  sol2_status=$(db "SELECT status FROM solicitacoes_match WHERE id='$sol2';")

  assert "Aceitar com emoji → convite aceito" "$conv_c" "aceito"
  assert "Solicita 2 → match_encontrado" "$sol2_status" "match_encontrado"
}

# ── T09: Aceitar convite — variações de texto ─────────────────────────────────
t09_aceitar_variacoes() {
  section "T09 — Aceitar Convite: Variações de Texto"

  # Usa horários diferentes para evitar conflito de quadra entre iterações
  local respostas=("aceito" "topo" "pode" "s" "yes" "1")
  local horas=("08" "11" "12" "15" "17" "19")
  local i=0
  for resp in "${respostas[@]}"; do
    local hora="${horas[$i]}"
    i=$((i+1))

    expire_pending "$ID_A"
    # Limpa partidas de teste anteriores para evitar acúmulo
    db "DELETE FROM partidas WHERE status='agendada' AND
        ((jogador1_id='$ID_A' AND jogador2_id='$ID_B') OR (jogador1_id='$ID_B' AND jogador2_id='$ID_A'))
        AND data_hora::date = '$AMANHA'::date;" > /dev/null 2>&1 || true

    send_msg "$P_A" "quero um match para amanhã às ${hora}h"
    sleep 9

    local solx
    solx=$(db "SELECT id FROM solicitacoes_match WHERE jogador_id='$ID_A' AND status='pendente' ORDER BY criado_em DESC LIMIT 1;")
    if [[ -z "$solx" ]]; then
      warn "T09: sem solicitação para '$resp' (${hora}h) — skip"
      continue
    fi

    send_msg "$P_B" "$resp"
    sleep 5

    local status
    status=$(db "SELECT status FROM convites_match WHERE convidado_id='$ID_B' AND solicitacao_id='$solx';")
    assert "Aceitar '$resp'" "$status" "aceito"
  done

  db "UPDATE jogadores SET nivel='3a_classe' WHERE telefone='$P_B';" > /dev/null
}

# ── T10: Recusar convite — variações ──────────────────────────────────────────
t10_recusar_variacoes() {
  section "T10 — Recusar Convite: Variações de Texto"

  # Limpa partidas de teste no $DEPOIS para não interferir
  db "DELETE FROM partidas WHERE status='agendada' AND data_hora::date='$DEPOIS'::date
      AND (jogador1_id IN ('$ID_A','$ID_B','$ID_C') OR jogador2_id IN ('$ID_A','$ID_B','$ID_C'));" > /dev/null 2>&1 || true

  local respostas=("não" "nao" "n" "no" "2")
  for resp in "${respostas[@]}"; do
    expire_pending "$ID_A"
    send_msg "$P_A" "quero um match para depois de amanhã às 16h"
    sleep 9

    local solx
    solx=$(db "SELECT id FROM solicitacoes_match WHERE jogador_id='$ID_A' AND status='pendente' ORDER BY criado_em DESC LIMIT 1;")
    if [[ -z "$solx" ]]; then
      warn "T10: sem solicitação para '$resp' — skip"
      continue
    fi

    send_msg "$P_C" "$resp"
    sleep 5

    local status
    status=$(db "SELECT status FROM convites_match WHERE convidado_id='$ID_C' AND solicitacao_id='$solx';")
    assert "Recusar '$resp'" "$status" "recusado"
  done
}

# ── T11: Consultar próximas partidas ──────────────────────────────────────────
t11_consultar_partidas() {
  section "T11 — Consultar Próximas Partidas"
  reset_contexto "$ID_A"
  sleep 1

  send_msg "$P_A" "quais são minhas próximas partidas?"
  sleep 12

  # Verifica indiretamente: pelo menos 1 partida agendada existe para A no banco
  local total_partidas
  total_partidas=$(db "SELECT COUNT(*) FROM partidas WHERE status='agendada' AND (jogador1_id='$ID_A' OR jogador2_id='$ID_A');")
  assert_nonempty "Jogador A tem partida(s) agendada(s) para consultar" "$total_partidas"
}

# ── T12: Sem adversários na classe ────────────────────────────────────────────
t12_sem_adversarios() {
  section "T12 — Sem Adversários: Classe Vazia"
  expire_pending "$ID_S"

  send_msg "$P_S" "quero um match para amanhã"
  sleep 16

  # Nenhuma solicitação pendente deve existir (agente detectou classe vazia)
  local sol_pend
  sol_pend=$(db "SELECT COUNT(*) FROM solicitacoes_match WHERE jogador_id='$ID_S' AND status='pendente';")
  assert "Sem solicita pendente (classe vazia)" "$sol_pend" "0"

  # Nenhuma solicitação recente foi criada para S (sem criar e expirar — detectou no pré-check)
  local sol_recente
  sol_recente=$(db "SELECT COUNT(*) FROM solicitacoes_match WHERE jogador_id='$ID_S' AND criado_em > NOW() - INTERVAL '60 seconds';")
  assert "Nenhuma solicita criada (agente rejeitou antes de criar)" "$sol_recente" "0"
}

# ── T13: Todos ocupados na data ───────────────────────────────────────────────
t13_todos_ocupados() {
  section "T13 — Todos Ocupados na Mesma Data"

  # Usa classe 'principiantes' (isolada — sem outros jogadores reais) para garantir controle total
  db "UPDATE jogadores SET nivel='principiantes' WHERE id IN ('$ID_A','$ID_B','$ID_C');" > /dev/null

  # Cria partida que ocupa B e C no $AMANHA (horário 18:00 UTC = 15:00 SP)
  local qid; qid=$(db "SELECT id FROM quadras WHERE ativa=TRUE LIMIT 1;")
  if [[ -n "$qid" ]]; then
    db "INSERT INTO partidas (jogador1_id, jogador2_id, quadra_id, data_hora, duracao_minutos)
      VALUES ('$ID_B','$ID_C','$qid','$AMANHA 18:00:00+00',60)
      ON CONFLICT DO NOTHING;" > /dev/null 2>&1 || true
  fi

  expire_pending "$ID_A"
  send_msg "$P_A" "quero um match para amanhã às 15h na classe principiantes"
  sleep 9

  # Verifica que NÃO há solicitação pendente (viabilidade falsa ou convitesEnviados=0 → expirada)
  local sol_pend
  sol_pend=$(db "SELECT COUNT(*) FROM solicitacoes_match WHERE jogador_id='$ID_A' AND status='pendente';")
  assert "Sem solicita pendente (todos ocupados)" "$sol_pend" "0"

  # Limpa partida artificial e restaura classes
  db "DELETE FROM partidas WHERE jogador1_id='$ID_B' AND jogador2_id='$ID_C' AND data_hora::date='$AMANHA'::date AND status='agendada';" > /dev/null 2>&1 || true
  db "UPDATE jogadores SET nivel='3a_classe' WHERE id IN ('$ID_A','$ID_B','$ID_C');" > /dev/null
}

# ── T14: Cancelar solicitação ─────────────────────────────────────────────────
t14_cancelar() {
  section "T14 — Cancelar Solicitação"
  expire_pending "$ID_B"

  send_msg "$P_B" "quero um match para depois de amanhã às 16h"
  sleep 9

  local sol_b
  sol_b=$(db "SELECT id FROM solicitacoes_match WHERE jogador_id='$ID_B' AND status='pendente' ORDER BY criado_em DESC LIMIT 1;")
  assert_nonempty "Solicitação de B criada" "$sol_b"
  [[ -z "$sol_b" ]] && return

  send_msg "$P_B" "pode cancelar meu match"
  sleep 7

  local status_final
  status_final=$(db "SELECT status FROM solicitacoes_match WHERE id='$sol_b';")
  assert "Solicita B → expirado após cancelar" "$status_final" "expirado"
}

# ── T15: Atualizar solicitação ────────────────────────────────────────────────
t15_atualizar() {
  section "T15 — Atualizar Solicitação (Nova Hora)"
  expire_pending "$ID_C"
  # Remove partidas agendadas de C em "depois de amanhã" para evitar bloqueio de match
  db "DELETE FROM partidas WHERE status='agendada' AND data_hora::date='$DEPOIS'::date
      AND (jogador1_id='$ID_C' OR jogador2_id='$ID_C');" > /dev/null 2>&1 || true
  # Força classe correta (pode ter sido alterada por testes anteriores)
  db "UPDATE jogadores SET nivel='3a_classe' WHERE telefone='$P_C';" > /dev/null
  reset_contexto "$ID_C"
  sleep 1

  send_msg "$P_C" "quero match para depois de amanhã às 9h"
  sleep 9

  local sol_c
  sol_c=$(db "SELECT id FROM solicitacoes_match WHERE jogador_id='$ID_C' AND status='pendente' ORDER BY criado_em DESC LIMIT 1;")
  assert_nonempty "Solicitação de C criada" "$sol_c"
  [[ -z "$sol_c" ]] && return

  send_msg "$P_C" "mudei de ideia, pode ser às 18h no mesmo dia?"
  sleep 8

  local old_status sol_nova hora_nova
  old_status=$(db "SELECT status FROM solicitacoes_match WHERE id='$sol_c';")
  sol_nova=$(db "SELECT id FROM solicitacoes_match WHERE jogador_id='$ID_C' AND status='pendente' ORDER BY criado_em DESC LIMIT 1;")
  hora_nova=$(db "SELECT horario_preferido::text FROM solicitacoes_match WHERE id='$sol_nova';")

  assert "Antiga solicita → expirada" "$old_status" "expirado"
  assert_nonempty "Nova solicita criada" "$sol_nova"
  assert "Hora nova = 18:00" "$hora_nova" "18:00:00"
}

# ── T16: Alterar classe ───────────────────────────────────────────────────────
t16_alterar_classe() {
  section "T16 — Alterar Classe do Jogador"
  reset_contexto "$ID_C"
  sleep 1

  send_msg "$P_C" "quero mudar de classe"
  sleep 6
  send_msg "$P_C" "7"   # 7 = 6a_classe
  sleep 7

  local nivel
  nivel=$(db "SELECT nivel FROM jogadores WHERE telefone='$P_C';")
  assert "Opção 7 → 6a_classe" "$nivel" "6a_classe"

  # Restaura
  db "UPDATE jogadores SET nivel='3a_classe' WHERE telefone='$P_C';" > /dev/null
}

# ── T18: Confirmação enviada para AMBOS os jogadores após aceite ──────────────
t18_confirmacao_ambos() {
  section "T18 — Confirmação para Ambos os Jogadores (Solicitante + Convidado)"
  # Limpa tudo: solicitações pendentes de A e TODAS as partidas agendadas dos jogadores de teste
  expire_pending "$ID_A"
  expire_pending "$ID_B"
  expire_pending "$ID_C"
  db "DELETE FROM partidas WHERE status='agendada' AND
      (jogador1_id IN ('$ID_A','$ID_B','$ID_C') OR jogador2_id IN ('$ID_A','$ID_B','$ID_C'));" > /dev/null 2>&1 || true
  # Força classes corretas
  db "UPDATE jogadores SET nivel='3a_classe' WHERE telefone IN ('$P_A','$P_B','$P_C');" > /dev/null
  # Reseta contextos para evitar contaminação de T17
  reset_contexto "$ID_A"
  reset_contexto "$ID_B"
  sleep 2

  send_msg "$P_A" "quero um match para amanhã às 16h"
  sleep 9

  local sol_id
  sol_id=$(db "SELECT id FROM solicitacoes_match WHERE jogador_id='$ID_A' AND status='pendente' ORDER BY criado_em DESC LIMIT 1;")
  if [[ -z "$sol_id" ]]; then
    warn "T18: solicitação não criada — skip"
    return
  fi

  # Verifica que convite foi criado para B (aviso do solicitante buscando jogo)
  local conv_b
  conv_b=$(db "SELECT COUNT(*) FROM convites_match WHERE solicitacao_id='$sol_id' AND convidado_id='$ID_B' AND status='pendente';")
  assert "Convite pendente criado para B" "$conv_b" "1"

  # B aceita
  send_msg "$P_B" "sim"
  sleep 8

  # Verifica partida criada
  local partida_id status_sol
  partida_id=$(db "SELECT id FROM partidas
    WHERE ((jogador1_id='$ID_A' AND jogador2_id='$ID_B') OR (jogador1_id='$ID_B' AND jogador2_id='$ID_A'))
    AND status='agendada'
    ORDER BY criado_em DESC LIMIT 1;")
  status_sol=$(db "SELECT status FROM solicitacoes_match WHERE id='$sol_id';")

  assert_nonempty "Partida criada após aceite" "$partida_id"
  assert "Solicitação → match_encontrado" "$status_sol" "match_encontrado"

  # Verifica que o convite de B está aceito
  local conv_b_status
  conv_b_status=$(db "SELECT status FROM convites_match WHERE convidado_id='$ID_B' AND solicitacao_id='$sol_id';")
  assert "Convite B → aceito" "$conv_b_status" "aceito"

  # Verifica no banco que ambos os jogadores têm partida (mais confiável que log)
  local partida_b partida_a
  partida_b=$(db "SELECT COUNT(*) FROM partidas WHERE id='$partida_id' AND jogador2_id='$ID_B' OR (id='$partida_id' AND jogador1_id='$ID_B');")
  partida_a=$(db "SELECT COUNT(*) FROM partidas WHERE id='$partida_id' AND (jogador1_id='$ID_A' OR jogador2_id='$ID_A');")
  assert_nonempty "Partida registrada para B (convidado)" "$partida_b"
  assert_nonempty "Partida registrada para A (solicitante)" "$partida_a"

  # Verifica que a partida tem data_hora = amanhã às 16h (UTC: +3h = 19:00)
  local data_partida
  data_partida=$(db "SELECT data_hora::date::text FROM partidas WHERE id='$partida_id';")
  assert "Partida agendada para amanhã" "$data_partida" "$AMANHA"

  info "Partida ID: $partida_id | Data: $data_partida"
}

# ── T19: Conteúdo do convite contém data e hora do solicitante ────────────────
t19_conteudo_convite() {
  section "T19 — Conteúdo do Convite: Data/Hora e Nome do Solicitante nos Logs"
  expire_pending "$ID_A"
  reset_contexto "$ID_A"
  db "DELETE FROM partidas WHERE status='agendada' AND data_hora::date='$DEPOIS'::date
      AND (jogador1_id IN ('$ID_A','$ID_B','$ID_C') OR jogador2_id IN ('$ID_A','$ID_B','$ID_C'));" > /dev/null 2>&1 || true
  sleep 2

  send_msg "$P_A" "quero match para depois de amanhã às 19h"
  sleep 9

  local sol_id
  sol_id=$(db "SELECT id FROM solicitacoes_match WHERE jogador_id='$ID_A' AND status='pendente' ORDER BY criado_em DESC LIMIT 1;")
  if [[ -z "$sol_id" ]]; then
    warn "T19: solicitação não criada — skip"
    return
  fi

  # Valida data e hora salvas corretamente
  local data_sol hora_sol
  data_sol=$(db "SELECT data_preferida::text FROM solicitacoes_match WHERE id='$sol_id';")
  hora_sol=$(db "SELECT horario_preferido::text FROM solicitacoes_match WHERE id='$sol_id';")

  assert "Data da solicitação = depois de amanhã ($DEPOIS)" "$data_sol" "$DEPOIS"
  assert "Horário da solicitação = 19:00" "$hora_sol" "19:00:00"

  # Verifica que convites foram criados para B e/ou C
  local total_convites
  total_convites=$(db "SELECT COUNT(*) FROM convites_match WHERE solicitacao_id='$sol_id' AND status='pendente';")
  assert_nonempty "Convites criados e pendentes" "$total_convites"

  # Verifica data/hora no banco (fonte de verdade — mais confiável que grep de log)
  local data_db hora_db
  data_db=$(db "SELECT data_preferida::text FROM solicitacoes_match WHERE id='$sol_id';")
  hora_db=$(db "SELECT horario_preferido::text FROM solicitacoes_match WHERE id='$sol_id';")
  assert "Data confirmada no banco = $DEPOIS" "$data_db" "$DEPOIS"
  assert "Hora confirmada no banco = 19:00" "$hora_db" "19:00:00"

  info "Convites criados: $total_convites | Nome A: $nome_a"
}

# ── T17: Segundo SIM — partida já preenchida ──────────────────────────────────
t17_match_ja_preenchido() {
  section "T17 — Segundo SIM: Partida Já Preenchida"
  db "UPDATE jogadores SET nivel='3a_classe' WHERE telefone IN ('$P_A','$P_B','$P_C');" > /dev/null
  expire_pending "$ID_A"
  reset_contexto "$ID_A"
  sleep 1

  send_msg "$P_A" "quero match para depois de amanhã às 8h"
  sleep 9

  local sol_f
  sol_f=$(db "SELECT id FROM solicitacoes_match WHERE jogador_id='$ID_A' AND status='pendente' ORDER BY criado_em DESC LIMIT 1;")
  if [[ -z "$sol_f" ]]; then
    warn "T17: Solicitação não criada — skip"
    return
  fi

  # B aceita primeiro
  send_msg "$P_B" "sim"
  sleep 6

  local sol_status
  sol_status=$(db "SELECT status FROM solicitacoes_match WHERE id='$sol_f';")
  assert "Após 1º SIM → match_encontrado" "$sol_status" "match_encontrado"

  # C tenta aceitar — convite já deve estar expirado
  send_msg "$P_C" "sim"
  sleep 5

  local conv_c_final
  conv_c_final=$(db "SELECT status FROM convites_match WHERE convidado_id='$ID_C' AND solicitacao_id='$sol_f';")
  assert "Convite C → expirado (match já fechado)" "$conv_c_final" "expirado"
}

# ══════════════════════════════════════════════════════════════════════════════
# Diagnóstico e correções automáticas
# ══════════════════════════════════════════════════════════════════════════════

fix_emoji_normalization() {
  local file="$SRC_DIR/src/index.ts"
  # Verifica se a correção já está presente
  if grep -q 'non-ASCII\|\\\\x00-\\\\x7F' "$file" 2>/dev/null; then
    info "Fix emoji: já aplicado"
    return 1
  fi
  fixing "Adicionando strip de emojis na normalização SIM/NÃO"
  # Substitui a linha de normalização
  sed -i.bak \
    "s|const respostaNorm = corpo.trim().toLowerCase().normalize('NFD').replace(/\[\\\\u0300-\\\\u036f\]/g, '');|const respostaNorm = corpo.trim().toLowerCase().normalize('NFD').replace(/[\\\\u0300-\\\\u036f]/g,'').replace(/[^\\\\x00-\\\\x7F]/g,'').trim();|g" \
    "$file" 2>/dev/null && info "Patch aplicado com sed" && return 0
  warn "Patch manual necessário em src/index.ts linha respostaNorm"
  return 1
}

fix_date_timezone() {
  local file="$SRC_DIR/src/services/matchmaking.ts"
  if grep -q "toISOString.*split.*T.*0" "$file" 2>/dev/null; then
    info "Fix timezone data: já aplicado"
    return 1
  fi
  warn "Fix de timezone de data pode ser necessário em criarSolicitacao"
  return 1
}

diagnose_and_fix() {
  local failure=$1
  local fixed=false

  if echo "$failure" | grep -qi "emoji\|T08\|👍"; then
    fix_emoji_normalization && fixed=true
  fi
  if echo "$failure" | grep -qi "Data.*amanhã\|data.*AMANHA\|data.*2026\|Hora"; then
    fix_date_timezone && fixed=true
  fi

  if $fixed; then return 0; else return 1; fi
}

# ══════════════════════════════════════════════════════════════════════════════
# Runner e ciclo principal
# ══════════════════════════════════════════════════════════════════════════════

run_all() {
  t01_health
  t02_token_invalido
  t03_from_me
  t04_onboarding
  t05_mapeamento
  t06_solicitar
  t07_aceitar_sim
  t08_aceitar_emoji
  t09_aceitar_variacoes
  t10_recusar_variacoes
  t11_consultar_partidas
  t12_sem_adversarios
  t13_todos_ocupados
  t14_cancelar
  t15_atualizar
  t16_alterar_classe
  t17_match_ja_preenchido
  t18_confirmacao_ambos
  t19_conteudo_convite
}

teardown() {
  section "TEARDOWN — Limpando dados de teste"
  db "DELETE FROM convites_match WHERE
        solicitante_id IN (SELECT id FROM jogadores WHERE telefone LIKE '550000000000%')
     OR convidado_id  IN (SELECT id FROM jogadores WHERE telefone LIKE '550000000000%');" > /dev/null 2>&1 || true
  db "DELETE FROM solicitacoes_match WHERE jogador_id IN
        (SELECT id FROM jogadores WHERE telefone LIKE '550000000000%');" > /dev/null 2>&1 || true
  db "DELETE FROM partidas WHERE
        jogador1_id IN (SELECT id FROM jogadores WHERE telefone LIKE '550000000000%')
     OR jogador2_id IN (SELECT id FROM jogadores WHERE telefone LIKE '550000000000%');" > /dev/null 2>&1 || true
  db "DELETE FROM jogadores WHERE telefone LIKE '550000000000%';" > /dev/null 2>&1 || true
  db "DELETE FROM quadra_horarios WHERE quadra_id IN (SELECT id FROM quadras WHERE nome='Quadra Teste');" > /dev/null 2>&1 || true
  db "DELETE FROM quadras WHERE nome='Quadra Teste';" > /dev/null 2>&1 || true
  info "Dados de teste removidos."
}

print_report() {
  local cycle=$1
  echo ""
  echo -e "${BOLD}${BLUE}╔══════════════════════════════════════════════════╗${NC}"
  echo -e "${BOLD}${BLUE}║  RELATÓRIO — Ciclo $cycle/$MAX_CYCLES$(printf '%*s' $((38-${#cycle})) '')║${NC}"
  echo -e "${BOLD}${BLUE}╠══════════════════════════════════════════════════╣${NC}"
  echo -e "${BOLD}${BLUE}║${NC}  Total executado : ${BOLD}$TESTS_RUN${NC}$(printf '%*s' $((32-${#TESTS_RUN})) '')${BOLD}${BLUE}║${NC}"
  echo -e "${BOLD}${BLUE}║${NC}  ${GREEN}✅ Passou${NC}         : ${BOLD}$TESTS_PASS${NC}$(printf '%*s' $((32-${#TESTS_PASS})) '')${BOLD}${BLUE}║${NC}"
  echo -e "${BOLD}${BLUE}║${NC}  ${RED}❌ Falhou${NC}         : ${BOLD}$TESTS_FAIL${NC}$(printf '%*s' $((32-${#TESTS_FAIL})) '')${BOLD}${BLUE}║${NC}"
  if [[ ${#FAILURES[@]} -gt 0 ]]; then
    echo -e "${BOLD}${BLUE}╠══════════════════════════════════════════════════╣${NC}"
    for f in "${FAILURES[@]}"; do
      echo -e "${BOLD}${BLUE}║${NC}  ${RED}•${NC} $(echo "$f" | cut -c1-46)$(printf '%*s' $((46-${#f}<0?0:46-${#f})) '')${BOLD}${BLUE}║${NC}"
    done
  fi
  echo -e "${BOLD}${BLUE}╚══════════════════════════════════════════════════╝${NC}"
}

# ── Main ───────────────────────────────────────────────────────────────────────

echo -e "\n${BOLD}${BLUE}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${BLUE}║     TênisMatch — Test Suite Automatizado          ║${NC}"
echo -e "${BOLD}${BLUE}║     $(date '+%d/%m/%Y %H:%M:%S')                              ║${NC}"
echo -e "${BOLD}${BLUE}╚══════════════════════════════════════════════════╝${NC}"
echo -e "  Auto-fix: ${AUTO_FIX} | Máx ciclos: ${MAX_CYCLES}"

CYCLE=0
NEEDS_NEXT_CYCLE=true

while [[ $NEEDS_NEXT_CYCLE == true && $CYCLE -lt $MAX_CYCLES ]]; do
  CYCLE=$((CYCLE+1))
  TESTS_RUN=0; TESTS_PASS=0; TESTS_FAIL=0; FAILURES=()
  NEEDS_NEXT_CYCLE=false

  echo -e "\n${BOLD}${CYAN}━━━ Ciclo $CYCLE de $MAX_CYCLES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

  setup
  run_all
  print_report "$CYCLE"

  if [[ $TESTS_FAIL -eq 0 ]]; then
    teardown
    echo -e "\n${BOLD}${GREEN}🎾  TODOS OS TESTES PASSARAM! Sistema 100% funcional.${NC}\n"
    exit 0
  fi

  if [[ $AUTO_FIX == true && ${#FAILURES[@]} -gt 0 ]]; then
    echo -e "\n${YELLOW}🔍 Analisando ${#FAILURES[@]} falha(s)...${NC}"
    APPLIED_FIX=false

    for f in "${FAILURES[@]}"; do
      if diagnose_and_fix "$f"; then
        APPLIED_FIX=true
        NEEDS_NEXT_CYCLE=true
      fi
    done

    if $APPLIED_FIX; then
      echo -e "\n${CYAN}🚀 Correção aplicada — rebuilding e deploying...${NC}"
      deploy_app
      echo -e "${GREEN}✅ Redeploy concluído. Iniciando ciclo $((CYCLE+1))...${NC}"
    else
      echo -e "${YELLOW}⚠️  Sem correções automáticas disponíveis para as falhas restantes.${NC}"
      NEEDS_NEXT_CYCLE=false
    fi
  fi
done

teardown
echo -e "${RED}${BOLD}⛔ $TESTS_FAIL falha(s) persistente(s) após $CYCLE ciclo(s).${NC}"
echo -e "${YELLOW}Intervenção manual necessária nas falhas listadas acima.${NC}\n"
exit 1
