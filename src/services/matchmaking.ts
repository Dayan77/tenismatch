/**
 * Serviço de Matchmaking
 *
 * Emparelha jogadores com coeficientes ELO próximos que tenham solicitações
 * pendentes compatíveis. Também cria a partida e atualiza as solicitações.
 */

import { query, withTransaction } from '../db/client.js';
import type { Jogador, Partida, SolicitacaoMatch, CriarSolicitacaoDTO, Convite } from '../types.js';

// ── Configurações ────────────────────────────────────────────

/** Diferença máxima de ELO para considerar um match compatível */
const TOLERANCIA_ELO_INICIAL = 150;
/** Após HORAS_PARA_AMPLIAR horas na fila, a tolerância dobra */
const HORAS_PARA_AMPLIAR = 24;
const TOLERANCIA_ELO_AMPLIADA = 300;

/** Duração padrão de uma partida em minutos */
const DURACAO_PADRAO = 60;

// ── Solicitações ─────────────────────────────────────────────

export async function criarSolicitacao(dto: CriarSolicitacaoDTO): Promise<SolicitacaoMatch> {
  // Passa a data como string YYYY-MM-DD para evitar conversão de timezone pelo driver pg
  // (Date objects são serializados usando o TZ local do Node.js, causando off-by-one)
  const dataStr = dto.data_preferida
    ? dto.data_preferida.toISOString().split('T')[0]
    : null;

  const { rows } = await query<SolicitacaoMatch>(
    `INSERT INTO solicitacoes_match
       (jogador_id, nivel_preferido, data_preferida, horario_preferido)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [
      dto.jogador_id,
      dto.nivel_preferido ?? null,
      dataStr,
      dto.horario_preferido ?? null,
    ]
  );
  const sol = rows[0];
  if (!sol) throw new Error('Falha ao criar solicitação de match.');
  return sol;
}

export async function listarSolicitacoesPendentes(): Promise<SolicitacaoMatch[]> {
  const { rows } = await query<SolicitacaoMatch>(
    `SELECT * FROM solicitacoes_match
      WHERE status = 'pendente'
      ORDER BY criado_em ASC`
  );
  return rows;
}

// ── Lógica central de matchmaking ───────────────────────────

/**
 * Tenta criar matches para todas as solicitações pendentes.
 * Retorna a lista de partidas criadas nessa rodada.
 */
export async function processarMatchmaking(): Promise<Partida[]> {
  const pendentes = await listarSolicitacoesPendentes();
  const criadas: Partida[] = [];
  const pareados = new Set<string>(); // solicitação_id já usada

  for (const solicitacao of pendentes) {
    if (pareados.has(solicitacao.id)) continue;

    const parceiro = await encontrarParceiro(solicitacao, pendentes, pareados);
    if (!parceiro) continue;

    const partida = await criarPartidaMatch(solicitacao, parceiro);
    if (partida) {
      criadas.push(partida);
      pareados.add(solicitacao.id);
      pareados.add(parceiro.id);
    }
  }

  return criadas;
}

// ── Busca de parceiro ────────────────────────────────────────

async function encontrarParceiro(
  solicitacao: SolicitacaoMatch,
  candidatos: SolicitacaoMatch[],
  excluidos: Set<string>
): Promise<SolicitacaoMatch | null> {
  const jogador = await obterJogador(solicitacao.jogador_id);
  if (!jogador) return null;

  const tolerancia = calcularTolerancia(solicitacao.criado_em);

  for (const candidato of candidatos) {
    if (candidato.id === solicitacao.id) continue;
    if (excluidos.has(candidato.id)) continue;
    if (candidato.jogador_id === solicitacao.jogador_id) continue;

    const adversario = await obterJogador(candidato.jogador_id);
    if (!adversario) continue;

    // Verifica compatibilidade de ELO
    if (Math.abs(jogador.coeficiente - adversario.coeficiente) > tolerancia) continue;

    // Verifica preferência de nível (opcional)
    if (solicitacao.nivel_preferido && adversario.nivel !== solicitacao.nivel_preferido) continue;
    if (candidato.nivel_preferido && jogador.nivel !== candidato.nivel_preferido) continue;

    return candidato;
  }

  return null;
}

function calcularTolerancia(criadoEm: Date): number {
  const horasNaFila = (Date.now() - new Date(criadoEm).getTime()) / 3_600_000;
  return horasNaFila >= HORAS_PARA_AMPLIAR
    ? TOLERANCIA_ELO_AMPLIADA
    : TOLERANCIA_ELO_INICIAL;
}

// ── Criação da partida ───────────────────────────────────────

async function criarPartidaMatch(
  sol1: SolicitacaoMatch,
  sol2: SolicitacaoMatch
): Promise<Partida | null> {
  // Resolve data+hora ANTES de buscar quadra (precisa do timestamp completo para overlap check)
  const dataHora = resolverDataHora(sol1, sol2);
  const quadra = await encontrarQuradraDisponivel(dataHora);
  if (!quadra) return null;

  return withTransaction(async (client) => {
    // Cria a partida
    const { rows: partidas } = await client.query<Partida>(
      `INSERT INTO partidas
         (jogador1_id, jogador2_id, quadra_id, data_hora, duracao_minutos)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [sol1.jogador_id, sol2.jogador_id, quadra.id, dataHora, DURACAO_PADRAO]
    );
    const partida = partidas[0];
    if (!partida) throw new Error('Falha ao inserir partida.');

    // Atualiza as duas solicitações
    await client.query(
      `UPDATE solicitacoes_match
          SET status = 'match_encontrado', partida_id = $1
        WHERE id = ANY($2::uuid[])`,
      [partida.id, [sol1.id, sol2.id]]
    );

    return partida;
  });
}

// ── Quadra disponível ────────────────────────────────────────

/**
 * Busca uma quadra disponível para a data/hora desejada.
 * Usa verificação de sobreposição temporal (±60 min) para permitir
 * múltiplas partidas no mesmo dia em horários diferentes.
 */
async function encontrarQuradraDisponivel(
  dataHora?: Date
): Promise<{ id: string } | null> {
  const data = dataHora ?? new Date();
  const diaSemana = data.getDay();
  const timestampISO = data.toISOString();

  const { rows } = await query<{ id: string }>(
    `SELECT q.id
       FROM quadras q
       JOIN quadra_horarios h ON h.quadra_id = q.id
      WHERE q.ativa = TRUE
        AND h.dia_semana = $1
        AND NOT EXISTS (
          SELECT 1 FROM partidas p
           WHERE p.quadra_id = q.id
             AND p.status NOT IN ('cancelada', 'concluida')
             AND p.data_hora < $2::timestamptz + INTERVAL '60 minutes'
             AND p.data_hora + INTERVAL '60 minutes' > $2::timestamptz
        )
      LIMIT 1`,
    [diaSemana, timestampISO]
  );

  return rows[0] ?? null;
}

function resolverDataHora(sol1: SolicitacaoMatch, sol2: SolicitacaoMatch): Date {
  // Preferência do primeiro solicitante; fallback: próximo dia útil às 10h
  if (sol1.data_preferida) {
    const d = new Date(sol1.data_preferida);
    if (sol1.horario_preferido) {
      const partes = sol1.horario_preferido.split(':').map(Number);
      d.setHours(partes[0] ?? 10, partes[1] ?? 0, 0, 0);
    } else {
      d.setHours(10, 0, 0, 0);
    }
    return d;
  }

  const amanha = new Date();
  amanha.setDate(amanha.getDate() + 1);
  amanha.setHours(10, 0, 0, 0);
  return amanha;
}

// ── Utilitários ──────────────────────────────────────────────

async function obterJogador(id: string): Promise<Jogador | null> {
  const { rows } = await query<Jogador>(
    `SELECT * FROM jogadores WHERE id = $1 AND ativo = TRUE`,
    [id]
  );
  return rows[0] ?? null;
}

// ── Verificação de viabilidade ───────────────────────────────

export interface ResultadoViabilidade {
  viavel: boolean;
  totalNaClasse: number;
  disponiveis: number;
  motivo?: string;
}

/**
 * Verifica ANTES de criar a solicitação se há adversários possíveis.
 * Retorna detalhes para o agente formular resposta imediata ao usuário.
 */
export async function verificarViabilidadeMatch(
  jogadorId: string,
  nivel: string,
  dataPreferida?: Date
): Promise<ResultadoViabilidade> {
  // Total de jogadores ativos na mesma classe (excluindo o próprio)
  const { rows: totalRows } = await query<{ total: string }>(
    `SELECT COUNT(*) AS total
       FROM jogadores
      WHERE nivel = $1
        AND id != $2
        AND ativo = TRUE`,
    [nivel, jogadorId]
  );
  const totalNaClasse = parseInt(totalRows[0]?.total ?? '0', 10);

  if (totalNaClasse === 0) {
    return {
      viavel: false,
      totalNaClasse: 0,
      disponiveis: 0,
      motivo: 'nenhum_jogador_na_classe',
    };
  }

  // Se não há data preferida, todos os da classe são "disponíveis"
  if (!dataPreferida) {
    return { viavel: true, totalNaClasse, disponiveis: totalNaClasse };
  }

  // Jogadores da classe SEM partida agendada nessa data
  const { rows: dispRows } = await query<{ total: string }>(
    `SELECT COUNT(*) AS total
       FROM jogadores j
      WHERE j.nivel = $1
        AND j.id != $2
        AND j.ativo = TRUE
        AND NOT EXISTS (
          SELECT 1 FROM partidas p
           WHERE (p.jogador1_id = j.id OR p.jogador2_id = j.id)
             AND p.status NOT IN ('cancelada', 'concluida')
             AND p.data_hora::date = $3::date
        )`,
    [nivel, jogadorId, dataPreferida.toISOString().split('T')[0]]
  );
  const disponiveis = parseInt(dispRows[0]?.total ?? '0', 10);

  if (disponiveis === 0) {
    return {
      viavel: false,
      totalNaClasse,
      disponiveis: 0,
      motivo: 'todos_ocupados_nessa_data',
    };
  }

  return { viavel: true, totalNaClasse, disponiveis };
}

// ── Notificação de solicitações sem match ────────────────────

export interface SolicitacaoPendente {
  id: string;
  jogador_id: string;
  nivel_preferido: string | null;
  data_preferida: Date | null;
  horario_preferido: string | null;
  criado_em: Date;
  nome: string;
  nivel: string;
  minutos_espera: number;
}

/**
 * Busca solicitações pendentes há mais de `minutosLimite` minutos
 * que ainda não receberam notificação de "sem match".
 */
export async function buscarSolicitacoesSemNotificacao(
  minutosLimite = 30
): Promise<SolicitacaoPendente[]> {
  const { rows } = await query<SolicitacaoPendente>(
    `SELECT sm.id, sm.jogador_id, sm.nivel_preferido, sm.data_preferida,
            sm.horario_preferido, sm.criado_em,
            j.nome, j.nivel,
            EXTRACT(EPOCH FROM (NOW() - sm.criado_em)) / 60 AS minutos_espera
       FROM solicitacoes_match sm
       JOIN jogadores j ON j.id = sm.jogador_id
      WHERE sm.status = 'pendente'
        AND sm.criado_em < NOW() - ($1 || ' minutes')::INTERVAL
        AND NOT EXISTS (
          SELECT 1 FROM notificacoes n
           WHERE n.destinatario_id = sm.jogador_id
             AND n.tipo IN ('sem_match_temporario', 'sem_match_impossivel')
             AND n.criado_em > sm.criado_em
        )
      ORDER BY sm.criado_em ASC`,
    [minutosLimite]
  );
  return rows;
}

// ── Sistema de convites ──────────────────────────────────────

export interface ConvidadoInfo {
  jogador_id: string;
  nome: string;
  telefone: string;
  convite_id: string;
}

/**
 * Cria convites para todos os jogadores disponíveis da mesma classe
 * e retorna a lista com dados para envio de WhatsApp.
 */
export async function criarConvitesParaSolicitacao(
  solicitacao: SolicitacaoMatch,
  solicitante: Jogador
): Promise<ConvidadoInfo[]> {
  const nivel = solicitacao.nivel_preferido ?? solicitante.nivel;

  // Busca jogadores disponíveis (mesma classe, não o solicitante, sem partida na data)
  // Extrai YYYY-MM-DD com segurança — pg pode retornar Date object (com TZ offset) ou string
  const rawDataPreferida = solicitacao.data_preferida;
  let dataFiltro: string | null = null;
  if (rawDataPreferida) {
    if (rawDataPreferida instanceof Date) {
      // pg retornou Date object com TZ local — usa UTC para obter a data armazenada
      dataFiltro = rawDataPreferida.toISOString().split('T')[0] ?? null;
    } else {
      // string no formato YYYY-MM-DD (pg padrão para date type)
      dataFiltro = String(rawDataPreferida).substring(0, 10);
    }
  }

  // Constrói timestamp completo (data+hora) para verificação de sobreposição temporal
  let timestampFiltro: string | null = null;
  if (dataFiltro && solicitacao.horario_preferido) {
    const baseDate = rawDataPreferida instanceof Date
      ? new Date(rawDataPreferida.getTime())
      : new Date(`${dataFiltro}T03:00:00.000Z`); // midnight SP ≈ 03:00 UTC
    const partes = solicitacao.horario_preferido.split(':').map(Number);
    baseDate.setHours(partes[0] ?? 10, partes[1] ?? 0, 0, 0);
    timestampFiltro = baseDate.toISOString();
  }

  console.log(`[criarConvites] solicitacao_id=${solicitacao.id} nivel=${nivel} solicitante_id=${solicitante.id} rawDataPreferida=${JSON.stringify(rawDataPreferida)} dataFiltro=${dataFiltro} timestampFiltro=${timestampFiltro}`);

  // Usa overlap temporal quando temos horário, senão fallback para data inteira
  const filtroPartida = timestampFiltro
    ? `AND NOT EXISTS (
        SELECT 1 FROM partidas p
         WHERE (p.jogador1_id = j.id OR p.jogador2_id = j.id)
           AND p.status NOT IN ('cancelada','concluida')
           AND p.data_hora < $3::timestamptz + INTERVAL '60 minutes'
           AND p.data_hora + INTERVAL '60 minutes' > $3::timestamptz
      )`
    : dataFiltro
    ? `AND NOT EXISTS (
        SELECT 1 FROM partidas p
         WHERE (p.jogador1_id = j.id OR p.jogador2_id = j.id)
           AND p.status NOT IN ('cancelada','concluida')
           AND p.data_hora::date = $3::date
      )`
    : '';

  const paramFiltro = timestampFiltro ?? dataFiltro;

  const { rows: candidatos } = await query<{ id: string; nome: string; telefone: string }>(
    `SELECT j.id, j.nome, j.telefone
       FROM jogadores j
      WHERE j.nivel = $1
        AND j.id != $2
        AND j.ativo = TRUE
        ${filtroPartida}
      ORDER BY RANDOM()
      LIMIT 10`,
    paramFiltro ? [nivel, solicitante.id, paramFiltro] : [nivel, solicitante.id]
  );

  console.log(`[criarConvites] candidatos encontrados: ${candidatos.length} →`, candidatos.map(c => c.nome).join(', ') || 'nenhum');
  if (candidatos.length === 0) return [];

  const convidados: ConvidadoInfo[] = [];

  for (const cand of candidatos) {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO convites_match (solicitacao_id, solicitante_id, convidado_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (solicitacao_id, convidado_id) DO NOTHING
       RETURNING id`,
      [solicitacao.id, solicitante.id, cand.id]
    );
    if (rows[0]) {
      convidados.push({ jogador_id: cand.id, nome: cand.nome, telefone: cand.telefone, convite_id: rows[0].id });
    }
  }

  return convidados;
}

/**
 * Verifica se o jogador tem algum convite pendente.
 * Retorna o convite mais antigo pendente, ou null.
 */
export async function verificarConvitePendente(
  jogadorId: string
): Promise<(Convite & { solicitante_nome: string; data_preferida: Date | null; horario_preferido: string | null }) | null> {
  const { rows } = await query<Convite & { solicitante_nome: string; data_preferida: Date | null; horario_preferido: string | null }>(
    `SELECT c.*, j.nome AS solicitante_nome, sm.data_preferida, sm.horario_preferido
       FROM convites_match c
       JOIN jogadores j       ON j.id  = c.solicitante_id
       JOIN solicitacoes_match sm ON sm.id = c.solicitacao_id
      WHERE c.convidado_id = $1
        AND c.status = 'pendente'
        AND sm.status = 'pendente'
      ORDER BY c.criado_em ASC
      LIMIT 1`,
    [jogadorId]
  );
  return rows[0] ?? null;
}

/**
 * Aceita um convite: cria a partida e atualiza ambas as solicitações.
 * Retorna a partida criada ou null se a solicitação já foi preenchida.
 */
export async function aceitarConvite(
  conviteId: string,
  convidadoId: string
): Promise<Partida | null> {
  // Busca o convite com dados da solicitação
  const { rows: convRows } = await query<{
    solicitacao_id: string; solicitante_id: string; data_preferida: Date | null; horario_preferido: string | null;
  }>(
    `SELECT c.solicitacao_id, c.solicitante_id, sm.data_preferida, sm.horario_preferido
       FROM convites_match c
       JOIN solicitacoes_match sm ON sm.id = c.solicitacao_id
      WHERE c.id = $1 AND c.status = 'pendente' AND sm.status = 'pendente'`,
    [conviteId]
  );
  const conv = convRows[0];
  if (!conv) return null; // solicitação já foi preenchida ou convite inválido

  // Resolve data+hora ANTES de buscar quadra (precisa do timestamp completo para overlap check)
  const dataHora = resolverDataHoraConvite(conv.data_preferida, conv.horario_preferido);
  const quadra = await encontrarQuradraDisponivel(dataHora);
  if (!quadra) return null;

  return withTransaction(async (client) => {
    // Cria a partida
    const { rows: partidas } = await client.query<Partida>(
      `INSERT INTO partidas (jogador1_id, jogador2_id, quadra_id, data_hora, duracao_minutos)
       VALUES ($1, $2, $3, $4, 60) RETURNING *`,
      [conv.solicitante_id, convidadoId, quadra.id, dataHora]
    );
    const partida = partidas[0];
    if (!partida) throw new Error('Falha ao criar partida.');

    // Marca a solicitação como preenchida
    await client.query(
      `UPDATE solicitacoes_match SET status = 'match_encontrado', partida_id = $1 WHERE id = $2`,
      [partida.id, conv.solicitacao_id]
    );

    // Marca o convite aceito e expira os demais da mesma solicitação
    await client.query(
      `UPDATE convites_match SET status = 'aceito' WHERE id = $1`,
      [conviteId]
    );
    await client.query(
      `UPDATE convites_match SET status = 'expirado'
        WHERE solicitacao_id = $1 AND id != $2 AND status = 'pendente'`,
      [conv.solicitacao_id, conviteId]
    );

    return partida;
  });
}

/**
 * Recusa um convite. Se todos os convidados recusaram, retorna true
 * para sinalizar que o solicitante deve ser notificado.
 */
export async function recusarConvite(conviteId: string): Promise<boolean> {
  await query(
    `UPDATE convites_match SET status = 'recusado' WHERE id = $1`,
    [conviteId]
  );

  // Verifica se ainda há convites pendentes para essa solicitação
  const { rows } = await query<{ total: string }>(
    `SELECT COUNT(*) AS total
       FROM convites_match c
       JOIN convites_match origem ON origem.id = $1
      WHERE c.solicitacao_id = origem.solicitacao_id
        AND c.status = 'pendente'`,
    [conviteId]
  );
  const pendentes = parseInt(rows[0]?.total ?? '0', 10);
  return pendentes === 0; // true = todos recusaram
}

/**
 * Expira convites pendentes com mais de 2 horas.
 */
export async function expirarConvitesAntigos(): Promise<number> {
  const { rowCount } = await query(
    `UPDATE convites_match SET status = 'expirado'
      WHERE status = 'pendente'
        AND criado_em < NOW() - INTERVAL '2 hours'`
  );
  return rowCount ?? 0;
}

/**
 * Expira convites "zumbi": pendentes cuja solicitação já não está mais pendente
 * (foi cancelada, expirada ou já teve match encontrado).
 */
export async function expirarConvitesZumbi(): Promise<number> {
  const { rowCount } = await query(
    `UPDATE convites_match c SET status = 'expirado'
      FROM solicitacoes_match sm
     WHERE c.solicitacao_id = sm.id
       AND c.status = 'pendente'
       AND sm.status != 'pendente'`
  );
  return rowCount ?? 0;
}

function resolverDataHoraConvite(data: Date | null, horario: string | null): Date {
  const base = data ? new Date(data) : new Date();
  if (!data) base.setDate(base.getDate() + 1);

  if (horario) {
    const partes = horario.split(':').map(Number);
    base.setHours(partes[0] ?? 10, partes[1] ?? 0, 0, 0);
  } else {
    base.setHours(10, 0, 0, 0);
  }
  return base;
}

export async function expirarSolicitacoesAntigas(diasLimite = 7): Promise<number> {
  const { rowCount } = await query(
    `UPDATE solicitacoes_match
        SET status = 'expirado'
      WHERE status = 'pendente'
        AND criado_em < NOW() - INTERVAL '1 day' * $1`,
    [diasLimite]
  );
  return rowCount ?? 0;
}
