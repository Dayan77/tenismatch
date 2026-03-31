-- ============================================================
-- TênisMatch — Schema do banco de dados (PostgreSQL)
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Jogadores ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jogadores (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  nome              TEXT        NOT NULL,
  telefone          TEXT        NOT NULL UNIQUE,   -- número WhatsApp
  email             TEXT        NOT NULL UNIQUE,
  nivel             TEXT        NOT NULL CHECK (nivel IN ('classe_pro','1a_classe','2a_classe','3a_classe','4a_classe','5a_classe','6a_classe','principiantes','feminino')),
  coeficiente       NUMERIC(8,2) NOT NULL DEFAULT 1000,
  partidas_jogadas  INTEGER     NOT NULL DEFAULT 0,
  partidas_vencidas INTEGER     NOT NULL DEFAULT 0,
  ativo             BOOLEAN     NOT NULL DEFAULT TRUE,
  criado_em         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_jogadores_nivel ON jogadores (nivel);
CREATE INDEX IF NOT EXISTS idx_jogadores_coeficiente ON jogadores (coeficiente);

-- ── Quadras ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS quadras (
  id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  nome        TEXT    NOT NULL,
  localizacao TEXT    NOT NULL,
  ativa       BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS quadra_horarios (
  id          SERIAL  PRIMARY KEY,
  quadra_id   UUID    NOT NULL REFERENCES quadras(id) ON DELETE CASCADE,
  dia_semana  SMALLINT NOT NULL CHECK (dia_semana BETWEEN 0 AND 6),
  hora_inicio TIME    NOT NULL,
  hora_fim    TIME    NOT NULL,
  UNIQUE (quadra_id, dia_semana, hora_inicio)
);

-- ── Partidas ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS partidas (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  jogador1_id      UUID        NOT NULL REFERENCES jogadores(id),
  jogador2_id      UUID        NOT NULL REFERENCES jogadores(id),
  quadra_id        UUID        NOT NULL REFERENCES quadras(id),
  data_hora        TIMESTAMPTZ NOT NULL,
  duracao_minutos  INTEGER     NOT NULL DEFAULT 60,
  status           TEXT        NOT NULL DEFAULT 'agendada'
                   CHECK (status IN ('agendada','confirmada','em_andamento','concluida','cancelada')),
  vencedor_id      UUID        REFERENCES jogadores(id),
  placar           TEXT,
  criado_em        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jogador1_id <> jogador2_id)
);

CREATE INDEX IF NOT EXISTS idx_partidas_data_hora ON partidas (data_hora);
CREATE INDEX IF NOT EXISTS idx_partidas_jogador1  ON partidas (jogador1_id);
CREATE INDEX IF NOT EXISTS idx_partidas_jogador2  ON partidas (jogador2_id);
CREATE INDEX IF NOT EXISTS idx_partidas_status    ON partidas (status);

-- ── Solicitações de Match ────────────────────────────────────

CREATE TABLE IF NOT EXISTS solicitacoes_match (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  jogador_id        UUID        NOT NULL REFERENCES jogadores(id),
  nivel_preferido   TEXT        CHECK (nivel_preferido IN ('classe_pro','1a_classe','2a_classe','3a_classe','4a_classe','5a_classe','6a_classe','principiantes','feminino')),
  data_preferida    DATE,
  horario_preferido TIME,
  status            TEXT        NOT NULL DEFAULT 'pendente'
                    CHECK (status IN ('pendente','match_encontrado','expirado')),
  partida_id        UUID        REFERENCES partidas(id),
  criado_em         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_solicitacoes_status    ON solicitacoes_match (status);
CREATE INDEX IF NOT EXISTS idx_solicitacoes_jogador   ON solicitacoes_match (jogador_id);

-- ── Convites de Match ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS convites_match (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  solicitacao_id  UUID        NOT NULL REFERENCES solicitacoes_match(id),
  solicitante_id  UUID        NOT NULL REFERENCES jogadores(id),
  convidado_id    UUID        NOT NULL REFERENCES jogadores(id),
  status          TEXT        NOT NULL DEFAULT 'pendente'
                  CHECK (status IN ('pendente','aceito','recusado','expirado')),
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (solicitacao_id, convidado_id)
);

CREATE INDEX IF NOT EXISTS idx_convites_convidado  ON convites_match (convidado_id);
CREATE INDEX IF NOT EXISTS idx_convites_solicitacao ON convites_match (solicitacao_id);
CREATE INDEX IF NOT EXISTS idx_convites_status      ON convites_match (status);

-- ── Notificações ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS notificacoes (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  destinatario_id  UUID        NOT NULL REFERENCES jogadores(id),
  tipo             TEXT        NOT NULL
                   CHECK (tipo IN (
                     'match_encontrado','partida_agendada','lembrete_partida',
                     'resultado_atualizado','partida_cancelada',
                     'sem_match_temporario','sem_match_impossivel'
                   )),
  mensagem         TEXT        NOT NULL,
  enviado          BOOLEAN     NOT NULL DEFAULT FALSE,
  criado_em        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notificacoes_enviado ON notificacoes (enviado);

-- ── Histórico ELO ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS historico_elo (
  id                SERIAL      PRIMARY KEY,
  jogador_id        UUID        NOT NULL REFERENCES jogadores(id),
  partida_id        UUID        NOT NULL REFERENCES partidas(id),
  coeficiente_antes NUMERIC(8,2) NOT NULL,
  coeficiente_depois NUMERIC(8,2) NOT NULL,
  delta             NUMERIC(8,2) NOT NULL,
  criado_em         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_elo_jogador ON historico_elo (jogador_id);
