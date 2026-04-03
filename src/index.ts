/**
 * TênisMatch — Ponto de entrada principal
 *
 * Inicia o servidor HTTP (Express) que expõe:
 *   POST /webhook/whatsapp    — recebe mensagens do Twilio
 *   GET  /api/jogadores       — lista jogadores
 *   POST /api/jogadores       — cadastra jogador
 *   GET  /api/ranking         — ranking ELO
 *   POST /api/partidas        — agenda partida manual
 *   POST /api/partidas/:id/resultado — registra resultado
 */

import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import { inicializarBanco, fecharConexao, query } from './db/client.js';
import { iniciarAgendador, pararAgendador } from './services/agendador.js';
import { obterRanking } from './services/coeficiente.js';
import { registrarResultado } from './services/coeficiente.js';
import { agendarPartida } from './services/agendador.js';
import {
  parsearWebhookEvolution,
  validarWebhookEvolution,
  resolverJogadorPorTelefone,
  salvarJidJogador,
  enviarMensagem,
} from './services/whatsapp.js';

/**
 * Envia uma resposta do agente que pode conter múltiplas mensagens separadas por "---".
 * Cada parte é enviada individualmente com um pequeno intervalo, simulando digitação humana.
 */
async function enviarResposta(destinatario: string, texto: string): Promise<void> {
  const partes = texto.split(/\n---\n/).map(p => p.trim()).filter(p => p.length > 0);
  for (let i = 0; i < partes.length; i++) {
    await enviarMensagem(destinatario, partes[i] ?? texto);
    if (i < partes.length - 1) {
      await new Promise<void>(r => setTimeout(r, 1000 + Math.random() * 500));
    }
  }
}
import { processarMensagem, obterContexto, limparContexto } from './services/agente.js';
import { verificarConvitePendente, aceitarConvite, recusarConvite } from './services/matchmaking.js';
import type { CriarJogadorDTO } from './types.js';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── Health check ─────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    banco: dbConectado ? 'conectado' : 'indisponível',
  });
});

// ── Middleware: requer banco ──────────────────────────────────

function requireDb(_req: Request, res: Response, next: NextFunction): void {
  if (!dbConectado) {
    res.status(503).json({ erro: 'Banco de dados indisponível. Configure DATABASE_URL no .env.' });
    return;
  }
  next();
}
app.use('/api', requireDb);
app.use('/webhook', requireDb);

// ── Fila de processamento por jogador ────────────────────────
// Garante que mensagens do mesmo jogador são processadas em série,
// evitando race conditions quando chegam duas mensagens em sequência rápida.
const filaProcessamento = new Map<string, Promise<void>>();

function encadearProcessamento(chave: string, fn: () => Promise<void>): void {
  const anterior = filaProcessamento.get(chave) ?? Promise.resolve();
  const proxima = anterior.then(fn).catch((err) =>
    console.error(`[Fila] Erro ao processar mensagem de ${chave}:`, err)
  );
  filaProcessamento.set(chave, proxima);
  // Limpa a entrada do Map quando a fila esvaziar (libera memória)
  proxima.finally(() => {
    if (filaProcessamento.get(chave) === proxima) {
      filaProcessamento.delete(chave);
    }
  });
}

// ── Webhook WhatsApp ─────────────────────────────────────────

app.post('/webhook/whatsapp', async (req: Request, res: Response) => {
  const bodyRaw = req.body as Record<string, unknown>;

  // Evolution API espera status 200 imediatamente
  res.sendStatus(200);

  // Extrai remoteJid do payload para usar como chave da fila (antes de parsear)
  const data = bodyRaw['data'] as Record<string, unknown> | undefined;
  const key  = data?.['key'] as Record<string, unknown> | undefined;
  const remoteJid    = String(key?.['remoteJid'] ?? 'unknown');
  const chaveJogador = remoteJid.split('@')[0] ?? remoteJid;

  encadearProcessamento(chaveJogador, async () => {
  try {
    console.log('[Webhook] Payload recebido:', JSON.stringify(bodyRaw));
    const { de, corpo } = parsearWebhookEvolution(bodyRaw);
    console.log(`[Webhook] Mensagem de ${de}: "${corpo}"`);

    const jogador = await resolverJogadorPorTelefone(de);
    console.log(`[Webhook] Jogador encontrado: ${jogador ? jogador.nome : 'nenhum (novo usuário)'}`);

    const contextoId = jogador?.id ?? de;
    const contexto = obterContexto(contextoId);
    // Garante que só seta jogador_id se for um UUID real
    if (jogador && !contexto.jogador_id) {
      contexto.jogador_id = jogador.id;
      // Salva o JID (@lid ou @s.whatsapp.net) para futuras mensagens
      if (de.includes('@')) await salvarJidJogador(jogador.id, de);
    } else if (!jogador) {
      // Novo usuário: garante que jogador_id não existe no contexto
      delete contexto.jogador_id;
    }
    // ── Atalho @lid: quando o remetente usa JID privado ─────────
    if (!jogador && de.includes('@lid')) {
      const soDigitos = corpo.replace(/\D/g, '');
      const match = soDigitos.match(/^(?:55)?(\d{10,11})$/);
      if (match) {
        const telefoneExtraido = soDigitos.startsWith('55') ? soDigitos : `55${soDigitos}`;
        console.log(`[Webhook] @lid enviou telefone: ${telefoneExtraido}`);
        const jogadorVinculado = await resolverJogadorPorTelefone(telefoneExtraido);
        if (jogadorVinculado) {
          // Jogador já existe → vincula JID e confirma
          await query(`UPDATE jogadores SET jid = $1 WHERE telefone = $2`, [de, telefoneExtraido]);
          await salvarJidJogador(jogadorVinculado.id, de);
          contexto.jogador_id = jogadorVinculado.id;
          console.log(`[Webhook] @lid vinculado ao jogador ${jogadorVinculado.nome}`);
          await enviarMensagem(
            telefoneExtraido,
            `✅ Pronto, *${jogadorVinculado.nome}*! Seu número foi vinculado. Pode usar o bot normalmente agora! 🎾`
          );
          return;
        }
        // Novo usuário: define telefone real e cai no fluxo de cadastro
        contexto.telefone = telefoneExtraido;
        console.log(`[Webhook] @lid novo usuário com telefone ${telefoneExtraido} — iniciando cadastro`);
        // Não retorna — passa ao agente para iniciar onboarding
      } else {
        // Sem telefone na mensagem: responde ao @lid e inicia onboarding
        console.log(`[Webhook] @lid sem cadastro e sem telefone na mensagem — iniciando onboarding pelo @lid`);
        // Não retorna — passa ao agente para solicitar o número de telefone
      }
    }

    if (!contexto.telefone) {
      contexto.telefone = de;
    }
    console.log(`[Webhook] Contexto: jogador_id=${contexto.jogador_id ?? 'undefined'}, telefone=${contexto.telefone ?? 'undefined'}`);

    // ── Intercepta respostas SIM/NÃO de convites ─────────────
    if (jogador) {
      const convite = await verificarConvitePendente(jogador.id);
      if (convite) {
        const respostaNorm = corpo.trim()
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')  // remove diacríticos (ã, é, etc.)
          .replace(/[^\x00-\x7F]/g, '')     // remove emojis e caracteres não-ASCII
          .trim();
        const aceitou  = ['sim', 's', 'yes', '1', 'aceito', 'topo', 'pode'].includes(respostaNorm);
        const recusou  = ['nao', 'n', 'no', '2', 'nope', 'nah', 'recuso'].includes(respostaNorm);

        if (aceitou) {
          console.log(`[Webhook] ${jogador.nome} aceitou convite ${convite.id}`);
          const resultado = await aceitarConvite(convite.id, jogador.id);
          if (resultado.ok) {
            const dataStr = new Date(resultado.partida.data_hora).toLocaleString('pt-BR', {
              dateStyle: 'short', timeStyle: 'short', timeZone: process.env.TZ ?? 'America/Sao_Paulo',
            });
            // Notifica o convidado
            await enviarMensagem(de,
              `É isso aí, *${jogador.nome}*! 🙌🎾\n\n` +
              `Partida confirmada com *${convite.solicitante_nome}* para *${dataStr}*. Vai ser incrível!`
            );
            // Notifica o solicitante
            const { rows: solRows } = await query<{ telefone: string; nome: string }>(
              `SELECT telefone, nome FROM jogadores WHERE id = $1`, [convite.solicitante_id]
            );
            if (solRows[0]) {
              await enviarMensagem(solRows[0].telefone,
                `🎾 Boa notícia! *${jogador.nome}* topou o desafio!\n\n` +
                `Vocês se encontram em *${dataStr}*. Aquece bem e vai com tudo! 💪`
              );
            }
          } else if (resultado.motivo === 'sem_quadra') {
            console.log(`[Webhook] ${jogador.nome} aceitou convite ${convite.id} mas sem quadra disponível`);
            await enviarMensagem(de,
              `Boa vontade não faltou, *${jogador.nome}*! 🙏\n\n` +
              `Infelizmente não encontramos uma quadra disponível nesse horário. ` +
              `O organizador será avisado para tentar outro horário. 🎾`
            );
            // Notifica o solicitante para que remarque
            const { rows: solRows } = await query<{ telefone: string; nome: string }>(
              `SELECT telefone, nome FROM jogadores WHERE id = $1`, [convite.solicitante_id]
            );
            if (solRows[0]) {
              await enviarMensagem(solRows[0].telefone,
                `⚠️ *${jogador.nome}* topou jogar, mas não há quadra disponível no horário solicitado.\n\n` +
                `Tente marcar para outro horário. 🎾`
              );
            }
          } else {
            await enviarMensagem(de,
              `Eita, foi por pouco! 😅 Outro jogador acabou de fechar essa vaga antes de você.\n\n` +
              `Mas fique ligado — pode chegar outro convite a qualquer momento. 🎾`
            );
          }
          return;
        }

        if (recusou) {
          console.log(`[Webhook] ${jogador.nome} recusou convite ${convite.id}`);
          const todosRecusaram = await recusarConvite(convite.id);
          await enviarMensagem(de,
            `Tudo bem, sem pressão! 😊 Se pintar uma vaga na agenda, é só falar que a gente acha um jogo pra você. 🎾`
          );
          if (todosRecusaram) {
            // Notifica o solicitante que todos recusaram
            const { rows: solRows } = await query<{ telefone: string }>(
              `SELECT telefone FROM jogadores WHERE id = $1`, [convite.solicitante_id]
            );
            if (solRows[0]) {
              await enviarMensagem(solRows[0].telefone,
                `Hmm, dessa vez não rolou — os jogadores disponíveis não puderam nessa data. 😕\n\n` +
                `Mas não desanima! Tenta outra data ou manda *"novo match"* que a gente busca de novo. 💪`
              );
            }
          }
          return;
        }

        // Mensagem livre com convite pendente — passa ao agente com contexto do convite
        contexto.convite_pendente = {
          id: convite.id,
          solicitante_id: convite.solicitante_id,
          solicitante_nome: convite.solicitante_nome,
          data_preferida: convite.data_preferida ? new Date(convite.data_preferida).toISOString() : null,
          horario_preferido: convite.horario_preferido ?? null,
        };
        console.log(`[Webhook] Convite pendente ${convite.id} adicionado ao contexto — passando ao agente`);
      }
    }

    // ── Passa para o agente de IA ─────────────────────────────
    console.log('[Webhook] Chamando processarMensagem...');
    const resposta = await processarMensagem(corpo, contexto);
    const partes = resposta.split(/\n---\n/).filter(p => p.trim().length > 0);
    console.log(`[Webhook] Resposta gerada (${resposta.length} chars, ${partes.length} parte(s))`);
    // Se @lid e jogador registrado, usa o telefone do banco para enviar
    const telefoneContexto = contexto.telefone && !contexto.telefone.includes('@lid') ? contexto.telefone : undefined;
    const destinatario = (de.includes('@lid'))
      ? (jogador?.telefone ?? telefoneContexto ?? de)
      : de;
    await enviarResposta(destinatario, resposta);
    console.log('[Webhook] Mensagem(ns) enviada(s) via Evolution API');

    // Se @lid e cadastro acabou de acontecer durante esta requisição, salva o JID
    if (de.includes('@lid') && contexto.jogador_id) {
      const telfReal = contexto.telefone && !contexto.telefone.includes('@lid') ? contexto.telefone : null;
      if (telfReal) await salvarJidJogador(contexto.jogador_id, de);
    }
  } catch (err) {
    console.error('[Webhook] Erro:', err);
  }
  }); // fim encadearProcessamento
});

// ── Jogadores ────────────────────────────────────────────────

app.get('/api/jogadores', async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, nome, nivel, coeficiente, partidas_jogadas, partidas_vencidas, criado_em
         FROM jogadores WHERE ativo = TRUE ORDER BY nome`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

app.post('/api/jogadores', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dto = req.body as CriarJogadorDTO;
    if (!dto.nome || !dto.telefone || !dto.email || !dto.nivel) {
      res.status(400).json({ erro: 'Campos obrigatórios: nome, telefone, email, nivel' });
      return;
    }

    const { rows } = await query(
      `INSERT INTO jogadores (nome, telefone, email, nivel)
       VALUES ($1, $2, $3, $4)
       RETURNING id, nome, nivel, coeficiente`,
      [dto.nome, dto.telefone, dto.email, dto.nivel]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// ── Agente (teste sem WhatsApp) ──────────────────────────────

app.post('/api/agente/chat', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { mensagem, jogador_id } = req.body as { mensagem: string; jogador_id?: string };
    if (!mensagem) { res.status(400).json({ erro: 'Campo obrigatório: mensagem' }); return; }

    const id = jogador_id ?? 'anonimo';
    const contexto = obterContexto(id);
    if (jogador_id && !contexto.jogador_id) contexto.jogador_id = jogador_id;

    const resposta = await processarMensagem(mensagem, contexto);
    res.json({ resposta });
  } catch (err) { next(err); }
});

// ── Reset de contexto (uso em testes) ───────────────────────

app.post('/api/debug/reset-contexto', (req: Request, res: Response) => {
  const token = req.query['token'] as string | undefined;
  if (token !== process.env.EVOLUTION_API_KEY) {
    res.sendStatus(403);
    return;
  }
  const { chave } = req.body as { chave?: string };
  if (!chave) { res.status(400).json({ erro: 'Campo obrigatório: chave' }); return; }
  limparContexto(chave);
  res.json({ ok: true, chave });
});

// ── Query direta ao banco (uso em testes) ────────────────────

app.post('/api/debug/query', async (req: Request, res: Response, next: NextFunction) => {
  const token = req.query['token'] as string | undefined;
  if (token !== process.env.EVOLUTION_API_KEY) {
    res.sendStatus(403);
    return;
  }
  try {
    const { sql, params } = req.body as { sql?: string; params?: unknown[] };
    if (!sql) { res.status(400).json({ erro: 'Campo obrigatório: sql' }); return; }
    const result = await query(sql, params);
    res.json({ rows: result.rows, rowCount: result.rowCount });
  } catch (err) { next(err); }
});

// ── Ranking ──────────────────────────────────────────────────

app.get('/api/ranking', async (req, res, next) => {
  try {
    const limite = Math.min(Number(req.query.limite ?? 20), 100);
    const ranking = await obterRanking(limite);
    res.json(ranking);
  } catch (err) { next(err); }
});

// ── Partidas ─────────────────────────────────────────────────

app.post('/api/partidas', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { jogador1_id, jogador2_id, quadra_id, data_hora, duracao_minutos } = req.body as {
      jogador1_id: string;
      jogador2_id: string;
      quadra_id: string;
      data_hora: string;
      duracao_minutos?: number;
    };

    if (!jogador1_id || !jogador2_id || !quadra_id || !data_hora) {
      res.status(400).json({ erro: 'Campos obrigatórios: jogador1_id, jogador2_id, quadra_id, data_hora' });
      return;
    }

    const partida = await agendarPartida(
      jogador1_id,
      jogador2_id,
      quadra_id,
      new Date(data_hora),
      duracao_minutos
    );
    res.status(201).json(partida);
  } catch (err) { next(err); }
});

app.post('/api/partidas/:id/resultado', async (req, res, next) => {
  try {
    const { vencedor_id, placar } = req.body as { vencedor_id: string; placar: string };
    const partidaId = req.params.id;

    if (!vencedor_id || !placar) {
      res.status(400).json({ erro: 'Campos obrigatórios: vencedor_id, placar' });
      return;
    }

    // Busca perdedor
    const { rows } = await query(
      `SELECT jogador1_id, jogador2_id FROM partidas WHERE id = $1`,
      [partidaId]
    );
    if (!rows[0]) { res.status(404).json({ erro: 'Partida não encontrada' }); return; }

    const { jogador1_id, jogador2_id } = rows[0];
    const perdedorId = vencedor_id === jogador1_id ? jogador2_id : jogador1_id;

    await query(
      `UPDATE partidas SET status = 'concluida', vencedor_id = $1, placar = $2 WHERE id = $3`,
      [vencedor_id, placar, partidaId]
    );

    const elo = await registrarResultado(partidaId, vencedor_id, perdedorId);
    res.json({ sucesso: true, elo });
  } catch (err) { next(err); }
});

// ── Tratamento de erros ──────────────────────────────────────

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[API] Erro não tratado:', err);
  res.status(500).json({ erro: 'Erro interno do servidor' });
});

// ── Inicialização ────────────────────────────────────────────

let dbConectado = false;

async function main(): Promise<void> {
  try {
    await inicializarBanco();
    dbConectado = true;
    iniciarAgendador();
  } catch (err) {
    console.warn('[TênisMatch] Banco indisponível — servidor inicia sem DB:', (err as Error).message);
  }

  const porta = Number(process.env.PORT ?? 3000);
  const servidor = app.listen(porta, () => {
    console.log(`[TênisMatch] Servidor rodando na porta ${porta}`);
  });

  // Encerramento gracioso
  const encerrar = async () => {
    console.log('\n[TênisMatch] Encerrando...');
    pararAgendador();
    servidor.close();
    await fecharConexao();
    process.exit(0);
  };

  process.on('SIGINT',  encerrar);
  process.on('SIGTERM', encerrar);
}

main().catch((err) => {
  console.error('[TênisMatch] Falha fatal na inicialização:', err);
  process.exit(1);
});
