// ============================================================
// Tipos centrais do TênisMatch
// ============================================================

export type NivelJogador =
  | 'classe_pro'
  | '1a_classe'
  | '2a_classe'
  | '3a_classe'
  | '4a_classe'
  | '5a_classe'
  | '6a_classe'
  | 'principiantes'
  | 'feminino';

export type StatusPartida =
  | 'agendada'
  | 'confirmada'
  | 'em_andamento'
  | 'concluida'
  | 'cancelada';

export type StatusSolicitacao = 'pendente' | 'match_encontrado' | 'expirado';

export type TipoNotificacao =
  | 'match_encontrado'
  | 'partida_agendada'
  | 'lembrete_partida'
  | 'resultado_atualizado'
  | 'partida_cancelada'
  | 'sem_match_temporario'
  | 'sem_match_impossivel';

// ── Jogador ─────────────────────────────────────────────────

export interface Jogador {
  id: string;
  nome: string;
  telefone: string;       // número WhatsApp no formato +55...
  email: string;
  nivel: NivelJogador;
  coeficiente: number;    // ELO — começa em 1000
  partidas_jogadas: number;
  partidas_vencidas: number;
  criado_em: Date;
  ativo: boolean;
}

export interface CriarJogadorDTO {
  nome: string;
  telefone: string;
  email: string;
  nivel: NivelJogador;
}

// ── Quadra ───────────────────────────────────────────────────

export interface HorarioDisponivel {
  dia_semana: number;   // 0 = domingo … 6 = sábado
  hora_inicio: string;  // "08:00"
  hora_fim: string;     // "22:00"
}

export interface Quadra {
  id: string;
  nome: string;
  localizacao: string;
  ativa: boolean;
  horarios: HorarioDisponivel[];
}

// ── Partida ──────────────────────────────────────────────────

export interface ResultadoPartida {
  vencedor_id: string;
  placar: string; // ex: "6-4, 7-5"
}

export interface Partida {
  id: string;
  jogador1_id: string;
  jogador2_id: string;
  quadra_id: string;
  data_hora: Date;
  duracao_minutos: number;
  status: StatusPartida;
  resultado?: ResultadoPartida;
  criado_em: Date;
}

export interface AgendarPartidaDTO {
  jogador1_id: string;
  jogador2_id: string;
  quadra_id: string;
  data_hora: Date;
  duracao_minutos?: number;
}

// ── Solicitação de Match ─────────────────────────────────────

export interface SolicitacaoMatch {
  id: string;
  jogador_id: string;
  nivel_preferido?: NivelJogador;
  data_preferida?: Date;
  horario_preferido?: string;
  status: StatusSolicitacao;
  partida_id?: string;
  criado_em: Date;
}

export interface CriarSolicitacaoDTO {
  jogador_id: string;
  nivel_preferido?: NivelJogador;
  data_preferida?: Date;
  horario_preferido?: string;
}

// ── Convite de Match ─────────────────────────────────────────

export type StatusConvite = 'pendente' | 'aceito' | 'recusado' | 'expirado';

export interface Convite {
  id: string;
  solicitacao_id: string;
  solicitante_id: string;
  convidado_id: string;
  status: StatusConvite;
  criado_em: Date;
}

// ── Coeficiente ELO ─────────────────────────────────────────

export interface ResultadoELO {
  jogador_id: string;
  coeficiente_antes: number;
  coeficiente_depois: number;
  delta: number;
}

export interface AtualizacaoELO {
  jogador1: ResultadoELO;
  jogador2: ResultadoELO;
}

// ── Notificação ──────────────────────────────────────────────

export interface Notificacao {
  id: string;
  destinatario_id: string;
  tipo: TipoNotificacao;
  mensagem: string;
  enviado: boolean;
  criado_em: Date;
}

// ── Agente IA ────────────────────────────────────────────────

export interface MensagemChat {
  role: 'user' | 'assistant';
  content: string;
}

export interface ConvitePendenteContexto {
  id: string;
  solicitante_id: string;
  solicitante_nome: string;
  data_preferida: string | null;    // ISO string ou null
  horario_preferido: string | null;
}

export interface ContextoAgente {
  jogador_id?: string;
  telefone?: string;       // número do WhatsApp para onboarding automático
  historico: MensagemChat[];
  convite_pendente?: ConvitePendenteContexto;
}
