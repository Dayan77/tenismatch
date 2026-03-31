/**
 * Serviço de Coeficiente ELO
 *
 * Calcula as variações de rating após cada partida usando o sistema ELO
 * adaptado para tênis. O fator K varia conforme o número de partidas
 * jogadas para que ratings iniciais se estabilizem mais rapidamente.
 */

import { query, withTransaction } from '../db/client.js';
import type { AtualizacaoELO, ResultadoELO } from '../types.js';

// ── Constantes ELO ───────────────────────────────────────────

const K_PROVISORIO = 40;  // primeiras 30 partidas
const K_NORMAL     = 20;  // 30–100 partidas
const K_ESTAVEL    = 10;  // > 100 partidas

function fatorK(partidasJogadas: number): number {
  if (partidasJogadas < 30)  return K_PROVISORIO;
  if (partidasJogadas < 100) return K_NORMAL;
  return K_ESTAVEL;
}

/** Probabilidade esperada de vitória para o jogador A sobre B */
function probabilidadeEsperada(ratingA: number, ratingB: number): number {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

/** Calcula o delta de ELO sem persistir */
export function calcularDeltaELO(
  ratingVencedor: number,
  ratingPerdedor: number,
  partidasVencedor: number
): number {
  const k = fatorK(partidasVencedor);
  const esperado = probabilidadeEsperada(ratingVencedor, ratingPerdedor);
  // score = 1 (vitória)
  return Math.round(k * (1 - esperado));
}

// ── Atualização após partida ─────────────────────────────────

/**
 * Registra o resultado de uma partida e atualiza o ELO de ambos os jogadores.
 * Persiste no historico_elo e atualiza a tabela jogadores atomicamente.
 */
export async function registrarResultado(
  partidaId: string,
  vencedorId: string,
  perdedorId: string
): Promise<AtualizacaoELO> {
  return withTransaction(async (client) => {
    // Busca dados atuais dos jogadores
    const { rows } = await client.query<{
      id: string;
      coeficiente: number;
      partidas_jogadas: number;
      partidas_vencidas: number;
    }>(
      `SELECT id, coeficiente, partidas_jogadas, partidas_vencidas
         FROM jogadores
        WHERE id = ANY($1::uuid[])`,
      [[vencedorId, perdedorId]]
    );

    const vencedor = rows.find((r) => r.id === vencedorId);
    const perdedor = rows.find((r) => r.id === perdedorId);

    if (!vencedor || !perdedor) {
      throw new Error('Jogador não encontrado para atualização de ELO.');
    }

    const deltaVencedor = calcularDeltaELO(
      vencedor.coeficiente,
      perdedor.coeficiente,
      vencedor.partidas_jogadas
    );
    const deltaPerdedor = -Math.abs(
      calcularDeltaELO(
        perdedor.coeficiente,
        vencedor.coeficiente,
        perdedor.partidas_jogadas
      )
    );

    const novoEloVencedor = Math.max(100, Number(vencedor.coeficiente) + deltaVencedor);
    const novoEloPerdedor = Math.max(100, Number(perdedor.coeficiente) + deltaPerdedor);

    // Atualiza vencedor
    await client.query(
      `UPDATE jogadores
          SET coeficiente       = $1,
              partidas_jogadas  = partidas_jogadas + 1,
              partidas_vencidas = partidas_vencidas + 1
        WHERE id = $2`,
      [novoEloVencedor, vencedorId]
    );

    // Atualiza perdedor
    await client.query(
      `UPDATE jogadores
          SET coeficiente      = $1,
              partidas_jogadas = partidas_jogadas + 1
        WHERE id = $2`,
      [novoEloPerdedor, perdedorId]
    );

    // Registra no histórico
    await client.query(
      `INSERT INTO historico_elo
         (jogador_id, partida_id, coeficiente_antes, coeficiente_depois, delta)
       VALUES
         ($1, $2, $3, $4, $5),
         ($6, $2, $7, $8, $9)`,
      [
        vencedorId, partidaId,
        vencedor.coeficiente, novoEloVencedor, deltaVencedor,
        perdedorId,
        perdedor.coeficiente, novoEloPerdedor, deltaPerdedor,
      ]
    );

    const resultadoVencedor: ResultadoELO = {
      jogador_id: vencedorId,
      coeficiente_antes: vencedor.coeficiente,
      coeficiente_depois: novoEloVencedor,
      delta: deltaVencedor,
    };

    const resultadoPerdedor: ResultadoELO = {
      jogador_id: perdedorId,
      coeficiente_antes: perdedor.coeficiente,
      coeficiente_depois: novoEloPerdedor,
      delta: deltaPerdedor,
    };

    return { jogador1: resultadoVencedor, jogador2: resultadoPerdedor };
  });
}

// ── Ranking ──────────────────────────────────────────────────

export async function obterRanking(limite = 50): Promise<
  Array<{ posicao: number; id: string; nome: string; coeficiente: number; nivel: string }>
> {
  const { rows } = await query<{ id: string; nome: string; coeficiente: number; nivel: string }>(
    `SELECT id, nome, coeficiente, nivel
       FROM jogadores
      WHERE ativo = TRUE
      ORDER BY coeficiente DESC
      LIMIT $1`,
    [limite]
  );

  return rows.map((r, i) => ({ posicao: i + 1, ...r }));
}

// ── Histórico de um jogador ──────────────────────────────────

export async function obterHistoricoELO(jogadorId: string, limite = 20): Promise<
  Array<{ partida_id: string; delta: number; coeficiente_depois: number; criado_em: Date }>
> {
  const { rows } = await query<{
    partida_id: string;
    delta: number;
    coeficiente_depois: number;
    criado_em: Date;
  }>(
    `SELECT partida_id, delta, coeficiente_depois, criado_em
       FROM historico_elo
      WHERE jogador_id = $1
      ORDER BY criado_em DESC
      LIMIT $2`,
    [jogadorId, limite]
  );
  return rows;
}
