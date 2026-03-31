/**
 * Serviço de Agendamento
 *
 * Executa tarefas periódicas via node-cron:
 *   - Processamento de matchmaking (a cada 15 min)
 *   - Lembretes de partidas (diário às 8h)
 *   - Expiração de solicitações antigas (diário à meia-noite)
 *   - Reenvio de notificações com falha (a cada hora)
 */

import cron from 'node-cron';
import { query } from '../db/client.js';
import { expirarSolicitacoesAntigas, buscarSolicitacoesSemNotificacao, verificarViabilidadeMatch, expirarConvitesAntigos, expirarConvitesZumbi } from './matchmaking.js';
import { enviarNotificacoePendentes } from './whatsapp.js';
import type { Partida, Jogador } from '../types.js';

const tarefas: cron.ScheduledTask[] = [];

// ── Inicialização ────────────────────────────────────────────

export function iniciarAgendador(): void {
  // Lembretes de partidas diariamente às 8h
  tarefas.push(
    cron.schedule('0 8 * * *', async () => {
      console.log('[Agendador] Enviando lembretes de partidas...');
      try {
        await criarLembretesPartidasHoje();
      } catch (err) {
        console.error('[Agendador] Erro nos lembretes:', err);
      }
    })
  );

  // Expirar solicitações e convites antigos à meia-noite
  tarefas.push(
    cron.schedule('0 0 * * *', async () => {
      console.log('[Agendador] Expirando solicitações e convites antigos...');
      try {
        const expiradas = await expirarSolicitacoesAntigas(7);
        const convitesExp = await expirarConvitesAntigos();
        const zumbisExp  = await expirarConvitesZumbi();
        console.log(`[Agendador] ${expiradas} solicitação(ões), ${convitesExp} convite(s) antigos e ${zumbisExp} convite(s) zumbi expirado(s).`);
      } catch (err) {
        console.error('[Agendador] Erro ao expirar:', err);
      }
    })
  );

  // Notificar jogadores sem match após 30 minutos (a cada 30 min)
  tarefas.push(
    cron.schedule('*/30 * * * *', async () => {
      try {
        await notificarSemMatch();
      } catch (err) {
        console.error('[Agendador] Erro ao notificar sem match:', err);
      }
    })
  );

  // Reenviar notificações com falha a cada hora
  tarefas.push(
    cron.schedule('0 * * * *', async () => {
      try {
        const enviadas = await enviarNotificacoePendentes();
        if (enviadas > 0) {
          console.log(`[Agendador] ${enviadas} notificação(ões) reenviada(s).`);
        }
      } catch (err) {
        console.error('[Agendador] Erro no reenvio de notificações:', err);
      }
    })
  );

  console.log('[Agendador] Tarefas agendadas com sucesso.');
}

export function pararAgendador(): void {
  tarefas.forEach((t) => t.stop());
  tarefas.length = 0;
  console.log('[Agendador] Todas as tarefas encerradas.');
}

// ── Notificações automáticas ─────────────────────────────────

async function criarNotificacoesDeMatch(partidas: Partida[]): Promise<void> {
  for (const partida of partidas) {
    const jogadores = await obterJogadoresDaPartida(partida);
    if (!jogadores) continue;

    const dataFormatada = new Date(partida.data_hora).toLocaleString('pt-BR', {
      dateStyle: 'short',
      timeStyle: 'short',
      timeZone: process.env.TZ ?? 'America/Sao_Paulo',
    });

    for (const [jogador, adversario] of [
      [jogadores.j1, jogadores.j2],
      [jogadores.j2, jogadores.j1],
    ] as const) {
      await registrarNotificacao(jogador.id, 'match_encontrado',
        `🎾 Match encontrado! Você vai jogar contra *${adversario.nome}* em ${dataFormatada}.`
      );
    }
  }
}

async function criarLembretesPartidasHoje(): Promise<void> {
  const { rows } = await query<Partida & { jogador1_nome: string; jogador2_nome: string }>(
    `SELECT p.*,
            j1.nome AS jogador1_nome,
            j2.nome AS jogador2_nome
       FROM partidas p
       JOIN jogadores j1 ON j1.id = p.jogador1_id
       JOIN jogadores j2 ON j2.id = p.jogador2_id
      WHERE p.data_hora::date = CURRENT_DATE
        AND p.status IN ('agendada', 'confirmada')`
  );

  for (const partida of rows) {
    const hora = new Date(partida.data_hora).toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: process.env.TZ ?? 'America/Sao_Paulo',
    });

    for (const [jogadorId, adversarioNome] of [
      [partida.jogador1_id, partida.jogador2_nome],
      [partida.jogador2_id, partida.jogador1_nome],
    ] as const) {
      const frases = [
        `Hoje tem jogo! 🎾 Você enfrenta *${adversarioNome}* às *${hora}*. Aquece bem e vai com tudo! 💪`,
        `Bom dia! Lembra que hoje às *${hora}* você joga contra *${adversarioNome}*! Vai ser uma boa partida! 🎾`,
        `Hoje é dia de quadra! ⏰ *${hora}* vs *${adversarioNome}*. Foca, respira e se diverte! 🏆`,
      ];
      const msg = frases[Math.floor(Math.random() * frases.length)]!;
      await registrarNotificacao(jogadorId, 'lembrete_partida', msg);
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────

async function obterJogadoresDaPartida(
  partida: Partida
): Promise<{ j1: Jogador; j2: Jogador } | null> {
  const { rows } = await query<Jogador>(
    `SELECT * FROM jogadores WHERE id = ANY($1::uuid[])`,
    [[partida.jogador1_id, partida.jogador2_id]]
  );
  const j1 = rows.find((r) => r.id === partida.jogador1_id);
  const j2 = rows.find((r) => r.id === partida.jogador2_id);
  if (!j1 || !j2) return null;
  return { j1, j2 };
}

async function notificarSemMatch(): Promise<void> {
  const pendentes = await buscarSolicitacoesSemNotificacao(30);
  if (pendentes.length === 0) return;

  console.log(`[Agendador] ${pendentes.length} solicitação(ões) sem match após 30 min.`);

  for (const sol of pendentes) {
    // Reavalia se ainda há candidatos disponíveis
    const nivel = sol.nivel_preferido ?? sol.nivel;
    const viabilidade = await verificarViabilidadeMatch(
      sol.jogador_id,
      nivel,
      sol.data_preferida ? new Date(sol.data_preferida) : undefined
    );

    let mensagem: string;
    let tipo: 'sem_match_temporario' | 'sem_match_impossivel';

    if (!viabilidade.viavel) {
      tipo = 'sem_match_impossivel';

      if (viabilidade.motivo === 'nenhum_jogador_na_classe') {
        mensagem =
          `Oi ${sol.nome}! Ainda não achei ninguém disponível na sua classe. 😕\n\n` +
          `Por enquanto você está sozinho nessa categoria — mas não desanima, a galera vai chegando! ` +
          `Se quiser, pode tentar outra classe respondendo *"mudar classe"* e a gente busca de novo. 💪`;
      } else {
        mensagem =
          `${sol.nome}, dei uma olhada aqui e os jogadores da sua classe já estão com agenda cheia nessa data. 😅\n\n` +
          `Que tal tentarmos em outra data? É só me mandar quando você pode que a gente resolve isso. ` +
          `Ou se preferir cancelar, responde *"cancelar match"*. 🎾`;
      }
    } else {
      tipo = 'sem_match_temporario';
      const mins = Math.round(Number(sol.minutos_espera));

      mensagem =
        `${sol.nome}, ainda estou garimpando o adversário perfeito pra você! ⏳ (${mins} min na fila)\n\n` +
        `Tem ${viabilidade.disponiveis} jogador(es) disponível(is) na sua classe — ` +
        `só estou ajustando o par pelo nível de jogo. Aguenta mais um pouco que vai sair! 🎾\n\n` +
        `Se quiser tentar outra data ou horário é só falar. E se mudar de ideia, manda *"cancelar match"*.`;
    }

    await registrarNotificacao(sol.jogador_id, tipo, mensagem);
  }

  await enviarNotificacoePendentes();
}

async function registrarNotificacao(
  destinatarioId: string,
  tipo: string,
  mensagem: string
): Promise<void> {
  await query(
    `INSERT INTO notificacoes (destinatario_id, tipo, mensagem)
     VALUES ($1, $2, $3)`,
    [destinatarioId, tipo, mensagem]
  );
}

// ── Execução manual de partidas ──────────────────────────────

export async function agendarPartida(
  jogador1Id: string,
  jogador2Id: string,
  quadraId: string,
  dataHora: Date,
  duracaoMinutos = 60
): Promise<Partida> {
  const { rows } = await query<Partida>(
    `INSERT INTO partidas
       (jogador1_id, jogador2_id, quadra_id, data_hora, duracao_minutos)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [jogador1Id, jogador2Id, quadraId, dataHora, duracaoMinutos]
  );

  const partida = rows[0];
  if (!partida) throw new Error('Falha ao criar partida no banco de dados.');

  // Notifica os jogadores
  const jogadores = await obterJogadoresDaPartida(partida);
  if (jogadores) {
    await criarNotificacoesDeMatch([partida]);
  }

  return partida;
}
