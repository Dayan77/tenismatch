/**
 * Serviço de WhatsApp via Evolution API
 *
 * Envia mensagens usando a API REST da Evolution API (self-hosted).
 * Também expõe um handler para webhook de mensagens recebidas
 * que são encaminhadas ao agente de IA.
 *
 * Variáveis de ambiente necessárias:
 *   EVOLUTION_API_URL      — URL base do servidor (ex: http://seu-vps:8080)
 *   EVOLUTION_API_KEY      — API key global da Evolution API
 *   EVOLUTION_INSTANCE     — Nome da instância criada na Evolution API
 */

import { query } from '../db/client.js';
import type { Notificacao } from '../types.js';

// ── Configuração ─────────────────────────────────────────────

function obterConfig(): { baseUrl: string; apiKey: string; instance: string } {
  const baseUrl  = process.env.EVOLUTION_API_URL;
  const apiKey   = process.env.EVOLUTION_API_KEY;
  const instance = process.env.EVOLUTION_INSTANCE;

  if (!baseUrl || !apiKey || !instance) {
    throw new Error(
      'Evolution API não configurada. Defina EVOLUTION_API_URL, EVOLUTION_API_KEY e EVOLUTION_INSTANCE no .env'
    );
  }

  return { baseUrl: baseUrl.replace(/\/$/, ''), apiKey, instance };
}

/**
 * Normaliza número de telefone para o formato Evolution API:
 * apenas dígitos, com código do país (ex: 5511999999999).
 * Remove sufixo @s.whatsapp.net se presente.
 */
function normalizarTelefone(telefone: string): string {
  // @lid é um identificador interno do WhatsApp — preserva completo para envio
  if (telefone.includes('@lid')) return telefone;
  const semSufixo = telefone.split('@')[0] ?? telefone;
  const digitos   = semSufixo.replace(/\D/g, '');
  if (digitos.startsWith('55') && digitos.length >= 12) return digitos;
  return `55${digitos}`;
}

// ── Envio de mensagem ────────────────────────────────────────

export async function enviarMensagem(
  destinatario: string,
  mensagem: string
): Promise<boolean> {
  try {
    const { baseUrl, apiKey, instance } = obterConfig();
    const number = normalizarTelefone(destinatario);

    const res = await fetch(`${baseUrl}/message/sendText/${instance}`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey':       apiKey,
      },
      body: JSON.stringify({ number, text: mensagem }),
    });

    if (!res.ok) {
      const erro = await res.text();
      console.error(`[WhatsApp] Evolution API erro ${res.status}:`, erro);
      return false;
    }

    return true;
  } catch (err) {
    console.error('[WhatsApp] Erro ao enviar mensagem:', err);
    return false;
  }
}

// ── Processamento de notificações pendentes ──────────────────

/**
 * Busca notificações não enviadas, envia via WhatsApp e marca como enviadas.
 * Retorna o número de notificações processadas com sucesso.
 */
export async function enviarNotificacoePendentes(): Promise<number> {
  const { rows: pendentes } = await query<
    Notificacao & { telefone: string }
  >(
    `SELECT n.*, j.telefone
       FROM notificacoes n
       JOIN jogadores j ON j.id = n.destinatario_id
      WHERE n.enviado = FALSE
        AND j.ativo = TRUE
      ORDER BY n.criado_em ASC
      LIMIT 50`
  );

  let sucesso = 0;

  for (const notif of pendentes) {
    const ok = await enviarMensagem(notif.telefone, notif.mensagem);
    if (ok) {
      await query(
        `UPDATE notificacoes SET enviado = TRUE WHERE id = $1`,
        [notif.id]
      );
      sucesso++;
    }
  }

  return sucesso;
}

// ── Webhook — mensagens recebidas ────────────────────────────

export interface MensagemRecebida {
  de: string;       // número do remetente (somente dígitos, ex: 5511999999999)
  corpo: string;
  timestamp: Date;
}

/**
 * Payload enviado pelo webhook da Evolution API (evento messages.upsert).
 */
interface EvolutionWebhookBody {
  event?:    string;
  instance?: string;
  apikey?:   string; // Evolution API reenvia a apikey no payload
  data?: {
    key?: {
      remoteJid?: string;
      fromMe?:    boolean;
      id?:        string;
    };
    message?: {
      conversation?:        string;
      extendedTextMessage?: { text?: string };
    };
    messageType?:      string;
    messageTimestamp?: number;
    pushName?:         string;
  };
}

/**
 * Processa payload do webhook Evolution API e retorna a mensagem normalizada.
 * - Ignora mensagens enviadas pelo próprio bot (fromMe = true)
 * - Ignora eventos que não sejam messages.upsert
 * - Ignora mensagens de grupos (@g.us)
 * - Lança erro se o payload for inválido ou não contiver texto
 */
export function parsearWebhookEvolution(body: EvolutionWebhookBody): MensagemRecebida {
  // Só processa evento de mensagem recebida
  if (body.event && body.event !== 'messages.upsert') {
    throw new Error(`Evento ignorado: ${body.event}`);
  }

  const key = body.data?.key;
  if (!key) throw new Error('Payload do webhook inválido: campo "data.key" ausente.');

  // Ignorar mensagens enviadas pelo próprio número
  if (key.fromMe === true) {
    throw new Error('Mensagem própria ignorada.');
  }

  const remoteJid = key.remoteJid ?? '';
  if (!remoteJid) throw new Error('Payload inválido: remoteJid ausente.');

  // Ignorar grupos
  if (remoteJid.endsWith('@g.us')) {
    throw new Error('Mensagem de grupo ignorada.');
  }

  const msg = body.data?.message;
  const corpo =
    msg?.conversation ??
    msg?.extendedTextMessage?.text ??
    '';

  if (!corpo.trim()) throw new Error('Mensagem sem conteúdo de texto.');

  return {
    de:        normalizarTelefone(remoteJid),
    corpo:     corpo.trim(),
    timestamp: new Date(),
  };
}

/**
 * Valida se a requisição do webhook veio da Evolution API.
 * Verifica o header "apikey" ou o campo apikey no body do payload.
 */
export function validarWebhookEvolution(
  apikeyHeader: string | undefined,
  bodyApikey?: string
): boolean {
  const esperado = process.env.EVOLUTION_API_KEY;
  if (!esperado) return true; // sem config, não bloqueia (dev local)
  return apikeyHeader === esperado || bodyApikey === esperado;
}

/**
 * Identifica o jogador pelo número de telefone.
 * Retorna null se não encontrado.
 */
export async function resolverJogadorPorTelefone(
  telefone: string
): Promise<{ id: string; nome: string; telefone: string } | null> {
  const numero = normalizarTelefone(telefone);
  const { rows } = await query<{ id: string; nome: string; telefone: string }>(
    `SELECT id, nome, telefone FROM jogadores WHERE telefone = $1 AND ativo = TRUE`,
    [numero]
  );
  return rows[0] ?? null;
}

// ── Notificações de resultado ────────────────────────────────

export async function notificarResultado(
  jogadorId: string,
  placar: string,
  vencedor: boolean
): Promise<void> {
  const { rows } = await query<{ telefone: string; nome: string }>(
    `SELECT telefone, nome FROM jogadores WHERE id = $1`,
    [jogadorId]
  );
  const jogador = rows[0];
  if (!jogador) return;

  const emoji     = vencedor ? '🏆' : '💪';
  const resultado = vencedor ? 'Você *venceu*' : 'Você *perdeu*';
  const msg       = `${emoji} ${resultado} a partida com placar ${placar}. Continue jogando!`;

  await enviarMensagem(jogador.telefone, msg);
}
