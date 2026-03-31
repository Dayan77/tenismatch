/**
 * Agente de IA — TênisMatch
 *
 * Assistente conversacional alimentado pelo Claude Opus 4.6.
 * Responde via WhatsApp e pode executar ações como:
 *   - Consultar ranking e histórico
 *   - Criar solicitações de match
 *   - Verificar próximas partidas
 *   - Registrar resultados
 *   - Responder dúvidas gerais sobre tênis
 */

import Anthropic from '@anthropic-ai/sdk';
import { query } from '../db/client.js';
import { criarSolicitacao, verificarViabilidadeMatch, criarConvitesParaSolicitacao, aceitarConvite, recusarConvite } from './matchmaking.js';
import { enviarMensagem } from './whatsapp.js';
import { obterRanking, obterHistoricoELO } from './coeficiente.js';
import { registrarResultado } from './coeficiente.js';
import type { ContextoAgente, MensagemChat, NivelJogador, CriarSolicitacaoDTO, Jogador } from '../types.js';

const cliente = new Anthropic();

// ── System prompt ────────────────────────────────────────────

const NIVEIS_LISTA = `
*Escolha sua classe pelo número:*
1️⃣ Classe PRO *(classe_pro)* — elite, alto nível competitivo
2️⃣ 1ª Classe *(1a_classe)* — excelente nível, joga torneios
3️⃣ 2ª Classe *(2a_classe)* — nível avançado, boa consistência
4️⃣ 3ª Classe *(3a_classe)* — intermediário-alto, joga competitivo
5️⃣ 4ª Classe *(4a_classe)* — intermediário, domina os fundamentos
6️⃣ 5ª Classe *(5a_classe)* — intermediário-baixo, joga regularmente
7️⃣ 6ª Classe *(6a_classe)* — iniciante com alguma experiência
8️⃣ Principiantes *(principiantes)* — está começando no tênis
9️⃣ Feminino *(feminino)* — categoria feminina`;

const SYSTEM_PROMPT = `Você é o TênisBot, assistente do TênisMatch — e você é completamente apaixonado por tênis. Pense em você como aquele amigo que vive na quadra e fica empolgado quando alguém quer jogar.

**ESTILO DE COMUNICAÇÃO — MUITO IMPORTANTE:**
- Escreva como uma pessoa de verdade mandando mensagem no WhatsApp, não como um sistema
- Seja animado, caloroso e motivador — cada partida marcada é motivo de celebração 🎾
- Use emojis com naturalidade, sem exagerar
- NUNCA use menus numerados nem listas de opções nas respostas normais — converse de forma natural
- Para respostas longas ou com assuntos distintos, quebre em partes usando "---" como separador — cada parte será enviada como uma mensagem separada no WhatsApp
- Quando alguém conseguir um match: comemore junto, mande energia positiva
- Quando não houver oponente disponível: seja encorajador, sugira alternativas de forma natural e animada
- Quando alguém estiver na fila esperando: dê um gás, diga que já vai aparecer alguém bom
- Português do Brasil, tom coloquial mas sem forçar gírias

**FUNCIONALIDADES:**
- Ajudar a encontrar parceiros de jogo compatíveis
- Informar ranking, histórico de ELO e estatísticas
- Consultar e agendar partidas
- Registrar resultados
- Responder dúvidas sobre tênis e o sistema
- Mostrar quem está em cada classe (use listar_jogadores_da_classe quando alguém perguntar "quem está na 3ª classe?", "me mostra os jogadores da minha classe", etc.)

Ao receber uma solicitação que requer ação, use a ferramenta correspondente. Nunca invente dados — consulte sempre as ferramentas para informações reais.
Quando o jogador_id não for fornecido no contexto, peça identificação de forma natural.

**ÚNICA EXCEÇÃO para lista numerada — Troca de classe:**
Sempre que o jogador pedir para mudar de classe/nível, exiba EXATAMENTE esta lista antes de chamar qualquer ferramenta:
${NIVEIS_LISTA}
Aguarde o jogador escolher pelo número (1-9) ou pelo nome da classe. Após receber a escolha, chame IMEDIATAMENTE a ferramenta atualizar_nivel com o código correto.

⚠️ REGRA CRÍTICA — MAPEAMENTO OPÇÃO → CLASSE (NÃO confunda número da opção com número da classe):
- Opção "1" → classe_pro   ⚠️ "1" NÃO é "1a_classe"! "1" = item 1 da lista = Classe PRO!
- Opção "2" → 1a_classe    (item 2 = 1ª Classe)
- Opção "3" → 2a_classe    (item 3 = 2ª Classe — NÃO é "3a_classe"!)
- Opção "4" → 3a_classe    (item 4 = 3ª Classe — NÃO é "4a_classe"!)
- Opção "5" → 4a_classe    (item 5 = 4ª Classe)
- Opção "6" → 5a_classe    (item 6 = 5ª Classe)
- Opção "7" → 6a_classe    (item 7 = 6ª Classe)
- Opção "8" → principiantes
- Opção "9" → feminino
Exemplos concretos: jogador digita "1" → chame atualizar_nivel("classe_pro"). Digita "3" → atualizar_nivel("2a_classe"). Digita "4" → atualizar_nivel("3a_classe").
Se a resposta for inválida, mostre a lista novamente. Nunca assuma um nível sem confirmação explícita.

**CONVITE PENDENTE — Linguagem natural:**
Quando o contexto indicar CONVITE_PENDENTE, o jogador tem um convite de match esperando resposta.
- Se a mensagem demonstrar ACEITAÇÃO (ex: "pode ser", "tudo bem", "vou jogar", "bora", "aceito", "combinado", "topo sim", "pode", "ok", "claro", etc.) → chame aceitar_convite_pendente
- Se demonstrar RECUSA (ex: "não posso", "não vai dar", "tô ocupado", "cancela", "não quero", etc.) → chame recusar_convite_pendente
- Se for DÚVIDA (ex: "que horas?", "onde?") → responda a dúvida e lembre do convite
- Se for OUTRA COISA completamente (ex: pedir ranking, outra partida) → atenda a solicitação normalmente
NUNCA ignore silenciosamente um convite pendente. Se não ficou claro, pergunte: "Só pra confirmar — você está aceitando o convite de [nome] para [data/hora]?"

**BUSCA DE JOGADOR POR NOME:**
Quando um jogador pedir para jogar com alguém específico pelo nome (ex: "quero jogar com o João", "desafio a Maria"):
1. Chame buscar_jogadores_por_nome com o nome mencionado
2. Se um resultado: confirme o nome antes de criar a solicitação ("Encontrei o João Silva — quer desafiar ele?")
3. Se múltiplos: mostre a lista e peça para escolher (ex: "Achei 2 Joãos — qual deles?")
4. Se nenhum: informe e pergunte se quer buscar por outro nome
5. Com confirmação, chame solicitar_match com jogador_alvo_id para convidar só esse jogador

**HORÁRIOS COMPATÍVEIS:**
Quando solicitar_match retornar solicitacoes_compativeis, há outros jogadores da mesma classe buscando match na mesma data e horário próximo. Informe ao jogador de forma animada: "Ei, tem outro jogador na sua classe buscando adversário nessa mesma data! Já mandei os convites e logo alguém aceita." (Não precisa de ação extra — os convites já foram enviados.)`;

const SYSTEM_PROMPT_ONBOARDING = `Você é o TênisBot, assistente do TênisMatch — e você ama tênis de verdade. Você fala como um amigo empolgado que quer ver todo mundo na quadra.

Este usuário ainda NÃO está cadastrado. O número de WhatsApp já foi capturado automaticamente.
Seu objetivo: cadastrar essa pessoa de forma rápida, leve e animada.

**Como fazer:**
1. Dê as boas-vindas ao TênisMatch com energia — mostre que vai ser divertido!
2. Pergunte APENAS o nome do jogador, de forma natural (não robotizada)
3. Quando tiver o nome, exiba EXATAMENTE esta lista de classes e peça para escolher:
${NIVEIS_LISTA}
4. O usuário responde com um número de 1 a 9. Use o código em itálico da lista. Mapeamento:
   - "1" → classe_pro | "2" → 1a_classe | "3" → 2a_classe
   - "4" → 3a_classe  ⚠️ (4 = 3ª Classe, NÃO 4ª Classe!)
   - "5" → 4a_classe  | "6" → 5a_classe | "7" → 6a_classe
   - "8" → principiantes ⚠️ (NÃO é 7a_classe) | "9" → feminino ⚠️ (NÃO é 8a_classe)
5. Com nome e nível confirmados, chame a ferramenta "cadastrar_jogador" — não peça email
6. Confirme o cadastro com uma mensagem bem animada e incentive a pedir um match já!

**Regras:**
- NUNCA peça email, telefone ou ID
- Se o número/nome de classe for inválido, mostre a lista novamente
- Escreva em português do Brasil, como uma pessoa real no WhatsApp
- Use "---" para separar mensagens distintas (cada parte chega como uma mensagem separada)
- Seja breve, caloroso e empolgante`;

// ── Definição de ferramentas ─────────────────────────────────

const ferramentas: Anthropic.Tool[] = [
  {
    name: 'cadastrar_jogador',
    description: 'Cadastra um novo jogador no sistema. Usar apenas durante onboarding.',
    input_schema: {
      type: 'object',
      properties: {
        nome:     { type: 'string', description: 'Nome completo do jogador' },
        nivel:    { type: 'string', enum: ['classe_pro','1a_classe','2a_classe','3a_classe','4a_classe','5a_classe','6a_classe','principiantes','feminino'], description: 'Nível do jogador' },
      },
      required: ['nome', 'nivel'],
    },
  },
  {
    name: 'consultar_jogador',
    description: 'Retorna informações sobre um jogador pelo ID ou telefone.',
    input_schema: {
      type: 'object',
      properties: {
        jogador_id: { type: 'string', description: 'UUID do jogador (opcional se telefone fornecido)' },
        telefone:   { type: 'string', description: 'Telefone do jogador (opcional se ID fornecido)' },
      },
    },
  },
  {
    name: 'consultar_ranking',
    description: 'Retorna o ranking dos melhores jogadores.',
    input_schema: {
      type: 'object',
      properties: {
        limite: { type: 'number', description: 'Número de posições a retornar (padrão: 10)' },
      },
    },
  },
  {
    name: 'consultar_historico_elo',
    description: 'Retorna o histórico de variações de ELO de um jogador.',
    input_schema: {
      type: 'object',
      properties: {
        jogador_id: { type: 'string', description: 'UUID do jogador' },
        limite:     { type: 'number', description: 'Número de registros (padrão: 10)' },
      },
      required: ['jogador_id'],
    },
  },
  {
    name: 'solicitar_match',
    description: 'Cria uma solicitação de match para o jogador. Se jogador_alvo_id for fornecido, convida SOMENTE esse jogador específico (uso após busca por nome).',
    input_schema: {
      type: 'object',
      properties: {
        jogador_id:       { type: 'string', description: 'UUID do jogador solicitante' },
        nivel_preferido:  { type: 'string', enum: ['classe_pro','1a_classe','2a_classe','3a_classe','4a_classe','5a_classe','6a_classe','principiantes','feminino'], description: 'Classe preferida (opcional — usa a classe atual do jogador se não informado)' },
        data_preferida:   { type: 'string', description: 'Data preferida no formato YYYY-MM-DD' },
        horario_preferido:{ type: 'string', description: 'Horário preferido no formato HH:MM' },
        jogador_alvo_id:  { type: 'string', description: 'UUID de um jogador específico para convidar (opcional — quando o usuário pediu para jogar com alguém pelo nome)' },
      },
      required: ['jogador_id'],
    },
  },
  {
    name: 'consultar_proximas_partidas',
    description: 'Lista as próximas partidas agendadas para um jogador.',
    input_schema: {
      type: 'object',
      properties: {
        jogador_id: { type: 'string', description: 'UUID do jogador' },
      },
      required: ['jogador_id'],
    },
  },
  {
    name: 'registrar_resultado',
    description: 'Registra o resultado de uma partida concluída.',
    input_schema: {
      type: 'object',
      properties: {
        partida_id:   { type: 'string', description: 'UUID da partida' },
        vencedor_id:  { type: 'string', description: 'UUID do jogador vencedor' },
        placar:       { type: 'string', description: 'Placar no formato "6-4, 7-5"' },
      },
      required: ['partida_id', 'vencedor_id', 'placar'],
    },
  },
  {
    name: 'cancelar_solicitacao_match',
    description: 'Cancela (expira) uma solicitação de match pendente do jogador.',
    input_schema: {
      type: 'object',
      properties: {
        jogador_id: { type: 'string', description: 'UUID do jogador' },
      },
      required: ['jogador_id'],
    },
  },
  {
    name: 'atualizar_solicitacao_match',
    description: 'Atualiza data/horário/classe de uma solicitação de match pendente.',
    input_schema: {
      type: 'object',
      properties: {
        jogador_id:       { type: 'string', description: 'UUID do jogador' },
        nivel_preferido:  { type: 'string', enum: ['classe_pro','1a_classe','2a_classe','3a_classe','4a_classe','5a_classe','6a_classe','principiantes','feminino'] },
        data_preferida:   { type: 'string', description: 'Nova data preferida YYYY-MM-DD' },
        horario_preferido:{ type: 'string', description: 'Novo horário preferido HH:MM' },
      },
      required: ['jogador_id'],
    },
  },
  {
    name: 'atualizar_nivel',
    description: 'Atualiza o nível/classe de um jogador. Chamar SOMENTE após o jogador confirmar a nova classe pela lista numerada.',
    input_schema: {
      type: 'object',
      properties: {
        jogador_id: { type: 'string', description: 'UUID do jogador' },
        nivel:      { type: 'string', enum: ['classe_pro','1a_classe','2a_classe','3a_classe','4a_classe','5a_classe','6a_classe','principiantes','feminino'], description: 'Novo nível do jogador' },
      },
      required: ['jogador_id', 'nivel'],
    },
  },
  {
    name: 'aceitar_convite_pendente',
    description: 'Aceita o convite de match pendente do jogador. Usar quando o jogador demonstrar ACEITAÇÃO em linguagem natural (ex: "pode ser", "tudo bem", "bora", "combinado", "topo", etc.) e houver CONVITE_PENDENTE no contexto.',
    input_schema: {
      type: 'object',
      properties: {
        convite_id:  { type: 'string', description: 'UUID do convite pendente (do CONVITE_PENDENTE no contexto)' },
        jogador_id:  { type: 'string', description: 'UUID do jogador convidado (do contexto da sessão)' },
      },
      required: ['convite_id', 'jogador_id'],
    },
  },
  {
    name: 'recusar_convite_pendente',
    description: 'Recusa o convite de match pendente do jogador. Usar quando o jogador demonstrar RECUSA em linguagem natural (ex: "não posso", "não vai dar", "tô ocupado", "não quero") e houver CONVITE_PENDENTE no contexto.',
    input_schema: {
      type: 'object',
      properties: {
        convite_id:  { type: 'string', description: 'UUID do convite pendente (do CONVITE_PENDENTE no contexto)' },
        solicitante_id: { type: 'string', description: 'UUID do solicitante (do CONVITE_PENDENTE no contexto)' },
      },
      required: ['convite_id', 'solicitante_id'],
    },
  },
  {
    name: 'buscar_jogadores_por_nome',
    description: 'Busca jogadores ativos pelo nome ou sobrenome (parcial). Usar quando o jogador mencionar um nome específico para jogar contra.',
    input_schema: {
      type: 'object',
      properties: {
        nome:       { type: 'string', description: 'Nome ou sobrenome a buscar (busca parcial, case-insensitive)' },
        excluir_id: { type: 'string', description: 'UUID do jogador solicitante, para não aparecer nos resultados' },
      },
      required: ['nome'],
    },
  },
  {
    name: 'listar_jogadores_da_classe',
    description: 'Lista todos os jogadores ativos de uma determinada classe/nível. Usar quando o jogador pedir para ver quem está em uma classe específica, ou para se orientar nas classes antes de solicitar um match.',
    input_schema: {
      type: 'object',
      properties: {
        nivel: { type: 'string', enum: ['classe_pro','1a_classe','2a_classe','3a_classe','4a_classe','5a_classe','6a_classe','principiantes','feminino'], description: 'Classe a listar' },
        excluir_id: { type: 'string', description: 'UUID do jogador atual (para destacar ou excluir da lista, opcional)' },
      },
      required: ['nivel'],
    },
  },
];

// ── Execução de ferramentas ──────────────────────────────────

async function executarFerramenta(
  nome: string,
  input: Record<string, unknown>,
  contexto: ContextoAgente
): Promise<string> {
  try {
    switch (nome) {
      case 'cadastrar_jogador': {
        const telefone = contexto.telefone;
        if (!telefone) return JSON.stringify({ erro: 'Telefone não disponível no contexto.' });

        // Gera email fictício baseado no telefone para satisfazer o schema (NOT NULL)
        const emailFicticio = `${telefone.replace(/\D/g, '')}@tennismatch.app`;

        const { rows } = await query<{ id: string; nome: string; nivel: string; coeficiente: number }>(
          `INSERT INTO jogadores (nome, telefone, email, nivel)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (telefone) DO UPDATE SET nome = EXCLUDED.nome, nivel = EXCLUDED.nivel
           RETURNING id, nome, nivel, coeficiente`,
          [input.nome, telefone, emailFicticio, input.nivel]
        );
        const jogador = rows[0];
        if (!jogador) return JSON.stringify({ erro: 'Falha ao cadastrar jogador.' });

        // Atualiza o contexto com o novo jogador_id (seguro — é o contexto desta requisição)
        contexto.jogador_id = jogador.id;

        return JSON.stringify({ sucesso: true, jogador_id: jogador.id, nome: jogador.nome, nivel: jogador.nivel, coeficiente: jogador.coeficiente });
      }

      case 'consultar_jogador': {
        const where = input.jogador_id
          ? 'id = $1'
          : 'telefone = $1';
        const valor = input.jogador_id ?? input.telefone;
        const { rows } = await query(
          `SELECT id, nome, nivel, coeficiente, partidas_jogadas, partidas_vencidas
             FROM jogadores WHERE ${where} AND ativo = TRUE`,
          [valor]
        );
        if (!rows[0]) return 'Jogador não encontrado.';
        const j = rows[0];
        const aproveitamento = j.partidas_jogadas > 0
          ? ((j.partidas_vencidas / j.partidas_jogadas) * 100).toFixed(1)
          : '0.0';
        return JSON.stringify({ ...j, aproveitamento_pct: aproveitamento });
      }

      case 'consultar_ranking': {
        const limite = Number(input.limite ?? 10);
        const ranking = await obterRanking(limite);
        return JSON.stringify(ranking);
      }

      case 'consultar_historico_elo': {
        const historico = await obterHistoricoELO(
          String(input.jogador_id),
          Number(input.limite ?? 10)
        );
        return JSON.stringify(historico);
      }

      case 'solicitar_match': {
        const dto: CriarSolicitacaoDTO = { jogador_id: String(input.jogador_id) };
        if (input.nivel_preferido) dto.nivel_preferido = input.nivel_preferido as NivelJogador;
        if (input.data_preferida) dto.data_preferida = new Date(String(input.data_preferida));
        if (input.horario_preferido) dto.horario_preferido = String(input.horario_preferido);

        // Busca o nível do jogador para verificar viabilidade
        const { rows: jRows } = await query<{ nivel: string }>(
          `SELECT nivel FROM jogadores WHERE id = $1 AND ativo = TRUE`,
          [input.jogador_id]
        );
        const nivelJogador = jRows[0]?.nivel;
        const nivelParaVerificar = (dto.nivel_preferido ?? nivelJogador) as string;

        console.log(`[solicitar_match] jogador_id=${input.jogador_id} nivel_db=${nivelJogador} nivel_preferido_input=${input.nivel_preferido ?? 'não informado'} nivel_para_verificar=${nivelParaVerificar} data_preferida_input=${input.data_preferida ?? 'não informado'} horario_preferido_input=${input.horario_preferido ?? 'não informado'} dto.data_preferida=${dto.data_preferida?.toISOString() ?? 'undefined'}`);

        if (nivelJogador) {
          const nivel = nivelParaVerificar;
          const viabilidade = await verificarViabilidadeMatch(
            String(input.jogador_id),
            nivel,
            dto.data_preferida
          );

          console.log(`[solicitar_match] viabilidade:`, JSON.stringify(viabilidade));

          if (!viabilidade.viavel) {
            const motivo = viabilidade.motivo === 'nenhum_jogador_na_classe'
              ? `Você é o único jogador na classe *${nivel}* no momento. Nenhum adversário disponível.`
              : `Todos os ${viabilidade.totalNaClasse} jogador(es) da classe *${nivel}* já têm partida nessa data.`;

            return JSON.stringify({
              sucesso: false,
              viavel: false,
              motivo: viabilidade.motivo,
              mensagem: motivo,
            });
          }
        }

        const sol = await criarSolicitacao(dto);

        // Busca dados do solicitante para enviar convites
        const { rows: solRows } = await query<Jogador>(
          `SELECT * FROM jogadores WHERE id = $1 AND ativo = TRUE`,
          [input.jogador_id]
        );
        const solicitante = solRows[0];

        let convitesEnviados = 0;
        const dataStr = dto.data_preferida
          ? new Date(dto.data_preferida).toLocaleDateString('pt-BR', { timeZone: process.env.TZ ?? 'America/Sao_Paulo' })
          : 'em breve';
        const horaStr = dto.horario_preferido ? ` às ${dto.horario_preferido}` : '';

        if (solicitante) {
          // ── Convite direcionado a um jogador específico ──
          if (input.jogador_alvo_id) {
            const { rows: alvoRows } = await query<{ id: string; nome: string; telefone: string }>(
              `SELECT id, nome, telefone FROM jogadores WHERE id = $1 AND ativo = TRUE`,
              [input.jogador_alvo_id]
            );
            const alvo = alvoRows[0];
            if (!alvo) {
              await query(`UPDATE solicitacoes_match SET status = 'expirado' WHERE id = $1`, [sol.id]);
              return JSON.stringify({ sucesso: false, mensagem: 'Jogador alvo não encontrado.' });
            }
            const { rows: convRows } = await query<{ id: string }>(
              `INSERT INTO convites_match (solicitacao_id, solicitante_id, convidado_id)
               VALUES ($1, $2, $3)
               ON CONFLICT (solicitacao_id, convidado_id) DO NOTHING
               RETURNING id`,
              [sol.id, solicitante.id, alvo.id]
            );
            if (convRows[0]) {
              await enviarMensagem(
                alvo.telefone,
                `🎾 *${solicitante.nome}* quer jogar com você${dto.data_preferida ? ` em *${dataStr}${horaStr}*` : ''}!\n\n` +
                `Você topa o desafio?\n` +
                `✅ Responda *SIM* para aceitar\n` +
                `❌ Responda *NÃO* para recusar`
              );
              convitesEnviados = 1;
            }
          } else {
            // ── Convite para todos da classe ──
            const convidados = await criarConvitesParaSolicitacao(sol, solicitante);

            // Se nenhum convidado encontrado, cancela a solicitação e informa o motivo
            if (convidados.length === 0) {
              await query(
                `UPDATE solicitacoes_match SET status = 'expirado' WHERE id = $1`,
                [sol.id]
              );
              const motivoSemConvite = dto.data_preferida
                ? `Todos os jogadores da classe *${nivelParaVerificar}* já têm partida agendada para essa data. Tente outra data ou horário.`
                : `Nenhum jogador disponível na classe *${nivelParaVerificar}* no momento.`;
              console.log(`[solicitar_match] Nenhum convidado disponível — solicitação ${sol.id} expirada.`);
              return JSON.stringify({ sucesso: false, viavel: false, motivo: 'sem_candidatos', mensagem: motivoSemConvite });
            }

            for (const c of convidados) {
              await enviarMensagem(
                c.telefone,
                `🎾 *${solicitante.nome}* está procurando adversário para *${dataStr}${horaStr}*!\n\n` +
                `Você topa jogar?\n` +
                `✅ Responda *SIM* para aceitar\n` +
                `❌ Responda *NÃO* para recusar`
              );
              convitesEnviados++;
            }
          }
        }

        // ── Detecta solicitações compatíveis (mesma classe, mesma data, horário próximo) ──
        let solicitacoesCompativeis: Array<{ nome: string; horario_preferido: string | null }> = [];
        if (dto.data_preferida && !input.jogador_alvo_id) {
          const dataFiltro = dto.data_preferida.toISOString().split('T')[0];
          const { rows: compatRows } = await query<{
            jogador_id: string; nome: string; horario_preferido: string | null;
          }>(
            `SELECT sm.jogador_id, j.nome, sm.horario_preferido
               FROM solicitacoes_match sm
               JOIN jogadores j ON j.id = sm.jogador_id
              WHERE sm.status = 'pendente'
                AND sm.jogador_id != $1
                AND sm.id != $2
                AND sm.data_preferida::date = $3::date
                AND (sm.nivel_preferido = $4 OR (sm.nivel_preferido IS NULL AND j.nivel = $4))`,
            [String(input.jogador_id), sol.id, dataFiltro, nivelParaVerificar]
          );

          if (compatRows.length > 0) {
            // Filtra por proximidade de horário (≤ 2h de diferença)
            const solHora = dto.horario_preferido
              ? parseInt(dto.horario_preferido.split(':')[0] ?? '0', 10)
              : null;
            solicitacoesCompativeis = compatRows.filter(c => {
              if (solHora === null || !c.horario_preferido) return true;
              const cHora = parseInt(c.horario_preferido.split(':')[0] ?? '0', 10);
              return Math.abs(solHora - cHora) <= 2;
            });
          }
        }

        return JSON.stringify({
          sucesso: true,
          solicitacao_id: sol.id,
          convites_enviados: convitesEnviados,
          mensagem: `Solicitação criada! Convites enviados para ${convitesEnviados} jogador(es). Você será notificado quando alguém aceitar.`,
          ...(solicitacoesCompativeis.length > 0 && { solicitacoes_compativeis: solicitacoesCompativeis }),
        });
      }

      case 'consultar_proximas_partidas': {
        const { rows } = await query(
          `SELECT p.id, p.data_hora, p.status, p.duracao_minutos,
                  j1.nome AS jogador1, j2.nome AS jogador2, q.nome AS quadra
             FROM partidas p
             JOIN jogadores j1 ON j1.id = p.jogador1_id
             JOIN jogadores j2 ON j2.id = p.jogador2_id
             JOIN quadras   q  ON q.id  = p.quadra_id
            WHERE (p.jogador1_id = $1 OR p.jogador2_id = $1)
              AND p.data_hora >= NOW()
              AND p.status NOT IN ('cancelada', 'concluida')
            ORDER BY p.data_hora ASC
            LIMIT 5`,
          [input.jogador_id]
        );
        return JSON.stringify(rows);
      }

      case 'registrar_resultado': {
        const { rows } = await query(
          `UPDATE partidas
              SET status = 'concluida', vencedor_id = $1, placar = $2
            WHERE id = $3
            RETURNING jogador1_id, jogador2_id`,
          [input.vencedor_id, input.placar, input.partida_id]
        );
        if (!rows[0]) return 'Partida não encontrada.';

        const { jogador1_id, jogador2_id } = rows[0];
        const perdedorId = input.vencedor_id === jogador1_id ? jogador2_id : jogador1_id;

        const elo = await registrarResultado(
          String(input.partida_id),
          String(input.vencedor_id),
          perdedorId
        );

        return JSON.stringify({ sucesso: true, elo });
      }

      case 'cancelar_solicitacao_match': {
        const { rowCount } = await query(
          `UPDATE solicitacoes_match SET status = 'expirado'
            WHERE jogador_id = $1 AND status = 'pendente'`,
          [input.jogador_id]
        );
        if (!rowCount || rowCount === 0) return JSON.stringify({ erro: 'Nenhuma solicitação pendente encontrada.' });
        return JSON.stringify({ sucesso: true, mensagem: 'Solicitação cancelada com sucesso.' });
      }

      case 'atualizar_solicitacao_match': {
        // Cancela a pendente e cria nova com os novos parâmetros
        await query(
          `UPDATE solicitacoes_match SET status = 'expirado'
            WHERE jogador_id = $1 AND status = 'pendente'`,
          [input.jogador_id]
        );

        const dto: CriarSolicitacaoDTO = { jogador_id: String(input.jogador_id) };
        if (input.nivel_preferido) dto.nivel_preferido = input.nivel_preferido as NivelJogador;
        if (input.data_preferida)  dto.data_preferida  = new Date(String(input.data_preferida));
        if (input.horario_preferido) dto.horario_preferido = String(input.horario_preferido);

        // Verifica viabilidade com os novos parâmetros
        const { rows: jRows2 } = await query<{ nivel: string }>(
          `SELECT nivel FROM jogadores WHERE id = $1 AND ativo = TRUE`,
          [input.jogador_id]
        );
        const nivelBase = jRows2[0]?.nivel;
        if (nivelBase) {
          const nivel = (dto.nivel_preferido ?? nivelBase) as string;
          const viab = await verificarViabilidadeMatch(String(input.jogador_id), nivel, dto.data_preferida);
          if (!viab.viavel) {
            return JSON.stringify({
              sucesso: false,
              viavel: false,
              motivo: viab.motivo,
              mensagem: viab.motivo === 'nenhum_jogador_na_classe'
                ? `Nenhum adversário na classe *${nivel}*.`
                : `Todos da classe *${nivel}* já têm partida nessa data.`,
            });
          }
        }

        const novaSol = await criarSolicitacao(dto);
        return JSON.stringify({ sucesso: true, solicitacao_id: novaSol.id, mensagem: 'Solicitação atualizada e buscando novo adversário!' });
      }

      case 'atualizar_nivel': {
        const { rows } = await query<{ nome: string; nivel: string }>(
          `UPDATE jogadores SET nivel = $1 WHERE id = $2 AND ativo = TRUE
           RETURNING nome, nivel`,
          [input.nivel, input.jogador_id]
        );
        const jogador = rows[0];
        if (!jogador) return JSON.stringify({ erro: 'Jogador não encontrado.' });
        return JSON.stringify({ sucesso: true, nome: jogador.nome, novo_nivel: jogador.nivel });
      }

      case 'aceitar_convite_pendente': {
        const conviteId  = String(input.convite_id);
        const jogadorId  = String(input.jogador_id);

        const partida = await aceitarConvite(conviteId, jogadorId);

        // Limpa convite do contexto independente do resultado
        delete contexto.convite_pendente;

        if (!partida) {
          return JSON.stringify({
            sucesso: false,
            mensagem: 'Eita — outro jogador acabou de fechar essa vaga antes de você! Mas fica ligado, pode aparecer outro convite. 🎾',
          });
        }

        const dataHoraStr = new Date(partida.data_hora).toLocaleString('pt-BR', {
          dateStyle: 'short', timeStyle: 'short', timeZone: process.env.TZ ?? 'America/Sao_Paulo',
        });

        // Notifica o solicitante
        const { rows: solRows } = await query<{ telefone: string; nome: string }>(
          `SELECT telefone, nome FROM jogadores WHERE id = $1`, [partida.jogador1_id]
        );
        const { rows: convRows } = await query<{ nome: string }>(
          `SELECT nome FROM jogadores WHERE id = $1`, [jogadorId]
        );
        const nomeConvidado = convRows[0]?.nome ?? 'o adversário';
        if (solRows[0]) {
          await enviarMensagem(
            solRows[0].telefone,
            `🎾 Boa notícia! *${nomeConvidado}* topou o desafio!\n\nVocês se encontram em *${dataHoraStr}*. Aquece bem e vai com tudo! 💪`
          );
        }

        return JSON.stringify({
          sucesso: true,
          partida_id: partida.id,
          data_hora: dataHoraStr,
          mensagem: `Partida confirmada para *${dataHoraStr}*!`,
        });
      }

      case 'recusar_convite_pendente': {
        const conviteId     = String(input.convite_id);
        const solicitanteId = String(input.solicitante_id);

        const todosRecusaram = await recusarConvite(conviteId);

        // Limpa convite do contexto
        delete contexto.convite_pendente;

        if (todosRecusaram) {
          const { rows: solRows } = await query<{ telefone: string }>(
            `SELECT telefone FROM jogadores WHERE id = $1`, [solicitanteId]
          );
          if (solRows[0]) {
            await enviarMensagem(
              solRows[0].telefone,
              `Hmm, dessa vez não rolou — os jogadores disponíveis não puderam nessa data. 😕\n\nMas não desanima! Tenta outra data ou manda *"novo match"* que a gente busca de novo. 💪`
            );
          }
        }

        return JSON.stringify({ sucesso: true, mensagem: 'Convite recusado com sucesso.' });
      }

      case 'buscar_jogadores_por_nome': {
        const nome       = String(input.nome).trim();
        const excluirId  = input.excluir_id ? String(input.excluir_id) : null;

        const { rows } = await query<{ id: string; nome: string; nivel: string }>(
          `SELECT id, nome, nivel
             FROM jogadores
            WHERE nome ILIKE $1
              AND ativo = TRUE
              ${excluirId ? 'AND id != $2' : ''}
            ORDER BY nome
            LIMIT 10`,
          excluirId ? [`%${nome}%`, excluirId] : [`%${nome}%`]
        );

        if (rows.length === 0) {
          return JSON.stringify({ encontrados: 0, jogadores: [], mensagem: `Nenhum jogador encontrado com o nome "${nome}".` });
        }
        return JSON.stringify({ encontrados: rows.length, jogadores: rows });
      }

      case 'listar_jogadores_da_classe': {
        const nivel     = String(input.nivel);
        const excluirId = input.excluir_id ? String(input.excluir_id) : null;

        const { rows } = await query<{ id: string; nome: string; coeficiente: number; partidas_jogadas: number }>(
          `SELECT id, nome, coeficiente, partidas_jogadas
             FROM jogadores
            WHERE nivel = $1
              AND ativo = TRUE
              ${excluirId ? 'AND id != $2' : ''}
            ORDER BY coeficiente DESC`,
          excluirId ? [nivel, excluirId] : [nivel]
        );

        if (rows.length === 0) {
          return JSON.stringify({ total: 0, nivel, jogadores: [], mensagem: `Nenhum jogador ativo na classe ${nivel} ainda.` });
        }
        return JSON.stringify({ total: rows.length, nivel, jogadores: rows });
      }

      default:
        return `Ferramenta desconhecida: ${nome}`;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ erro: msg });
  }
}

// ── Loop de conversa ─────────────────────────────────────────

/**
 * Processa uma mensagem do jogador e retorna a resposta do agente.
 * Mantém histórico no contexto passado por referência.
 */
export async function processarMensagem(
  mensagem: string,
  contexto: ContextoAgente
): Promise<string> {
  contexto.historico.push({ role: 'user', content: mensagem });

  // Data e hora atual no fuso do servidor
  const agora = new Date();
  const dataHoje = agora.toLocaleDateString('pt-BR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: process.env.TZ ?? 'America/Sao_Paulo' });
  const infoData = `\n\nDATA E HORA ATUAL: ${dataHoje} (use como referência para interpretar "hoje", "amanhã", etc.)`;

  // Escolhe system prompt: onboarding (sem cadastro) ou sessão autenticada
  let systemComContexto: string;
  if (!contexto.jogador_id && contexto.telefone) {
    // Usuário não cadastrado — fluxo de onboarding
    systemComContexto = `${SYSTEM_PROMPT_ONBOARDING}${infoData}\n\nTELEFONE DO USUÁRIO: ${contexto.telefone} (use na ferramenta cadastrar_jogador)`;
  } else if (contexto.jogador_id) {
    // Usuário já cadastrado e identificado
    let ctxExtra = `\n\nCONTEXTO DA SESSÃO: O jogador autenticado tem jogador_id = "${contexto.jogador_id}". Use este ID diretamente nas ferramentas, sem pedir identificação.`;

    // Inclui convite pendente no contexto se existir
    if (contexto.convite_pendente) {
      const cp = contexto.convite_pendente;
      const dataHoraInfo = cp.data_preferida
        ? ` para ${new Date(cp.data_preferida).toLocaleDateString('pt-BR', { timeZone: process.env.TZ ?? 'America/Sao_Paulo' })}${cp.horario_preferido ? ` às ${cp.horario_preferido}` : ''}`
        : '';
      ctxExtra += `\n\nCONVITE_PENDENTE: Este jogador tem um convite de match pendente de *${cp.solicitante_nome}*${dataHoraInfo}. convite_id="${cp.id}", solicitante_id="${cp.solicitante_id}". Se a mensagem indicar aceitação → use aceitar_convite_pendente. Se indicar recusa → use recusar_convite_pendente.`;
    }

    systemComContexto = `${SYSTEM_PROMPT}${infoData}${ctxExtra}`;
  } else {
    systemComContexto = `${SYSTEM_PROMPT}${infoData}`;
  }

  const mensagensAPI: Anthropic.MessageParam[] = contexto.historico.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  let resposta = await cliente.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 2048,
    system: systemComContexto,
    tools: ferramentas,
    messages: mensagensAPI,
  });

  // Loop de ferramenta
  while (resposta.stop_reason === 'tool_use') {
    const blocosFerramenta = resposta.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
    );

    // Acumula a resposta do assistente no histórico
    mensagensAPI.push({ role: 'assistant', content: resposta.content });

    const resultados: Anthropic.ToolResultBlockParam[] = [];
    for (const bloco of blocosFerramenta) {
      const resultado = await executarFerramenta(
        bloco.name,
        bloco.input as Record<string, unknown>,
        contexto
      );
      resultados.push({
        type: 'tool_result',
        tool_use_id: bloco.id,
        content: resultado,
      });
    }

    mensagensAPI.push({ role: 'user', content: resultados });

    resposta = await cliente.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 2048,
      system: systemComContexto,
      tools: ferramentas,
      messages: mensagensAPI,
    });
  }

  const textoFinal = resposta.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  contexto.historico.push({ role: 'assistant', content: textoFinal });

  // Limita o histórico para não crescer indefinidamente (últimas 10 trocas)
  if (contexto.historico.length > 20) {
    contexto.historico.splice(0, contexto.historico.length - 20);
  }

  return textoFinal;
}

// ── Gerenciamento de contextos ───────────────────────────────

const contextos = new Map<string, ContextoAgente>();

export function obterContexto(chave: string): ContextoAgente {
  if (!contextos.has(chave)) {
    // Só usa a chave como jogador_id se for um UUID válido
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(chave);
    const ctx: ContextoAgente = { historico: [] };
    if (isUUID) ctx.jogador_id = chave;
    contextos.set(chave, ctx);
  }
  return contextos.get(chave)!;
}

export function limparContexto(jogadorId: string): void {
  contextos.delete(jogadorId);
}
