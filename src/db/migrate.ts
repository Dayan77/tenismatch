/**
 * Script de migração incremental do banco de dados.
 *
 * Executa apenas as alterações que ainda não foram aplicadas.
 * Seguro para rodar múltiplas vezes (idempotente).
 *
 * Uso: npm run db:migrate
 */

import 'dotenv/config';
import { inicializarBanco, query, fecharConexao } from './client.js';

async function migrar(): Promise<void> {
  await inicializarBanco();

  // ── Tabela de controle de migrações ─────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS _migracoes (
      id        SERIAL      PRIMARY KEY,
      nome      TEXT        NOT NULL UNIQUE,
      aplicada_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const migrações: Array<{ nome: string; sql: string }> = [

    // ── v1: Adicionar tipos de notificação sem_match ─────────
    {
      nome: 'v1_notificacoes_sem_match',
      sql: `
        ALTER TABLE notificacoes
          DROP CONSTRAINT IF EXISTS notificacoes_tipo_check;
        ALTER TABLE notificacoes
          ADD CONSTRAINT notificacoes_tipo_check
          CHECK (tipo IN (
            'match_encontrado','partida_agendada','lembrete_partida',
            'resultado_atualizado','partida_cancelada',
            'sem_match_temporario','sem_match_impossivel'
          ));
      `,
    },

    // ── v2: Atualizar classes para novo sistema ───────────────
    {
      nome: 'v2_niveis_classes',
      sql: `
        ALTER TABLE jogadores
          DROP CONSTRAINT IF EXISTS jogadores_nivel_check;
        ALTER TABLE jogadores
          ADD CONSTRAINT jogadores_nivel_check
          CHECK (nivel IN (
            'classe_pro','1a_classe','2a_classe','3a_classe','4a_classe',
            '5a_classe','6a_classe','principiantes','feminino'
          ));

        ALTER TABLE solicitacoes_match
          DROP CONSTRAINT IF EXISTS solicitacoes_match_nivel_preferido_check;
        ALTER TABLE solicitacoes_match
          ADD CONSTRAINT solicitacoes_match_nivel_preferido_check
          CHECK (nivel_preferido IN (
            'classe_pro','1a_classe','2a_classe','3a_classe','4a_classe',
            '5a_classe','6a_classe','principiantes','feminino'
          ));
      `,
    },

  ];

  for (const migracao of migrações) {
    const { rows } = await query(
      `SELECT id FROM _migracoes WHERE nome = $1`,
      [migracao.nome]
    );

    if (rows.length > 0) {
      console.log(`[Migração] ⏭  ${migracao.nome} — já aplicada, pulando.`);
      continue;
    }

    try {
      await query(migracao.sql);
      await query(`INSERT INTO _migracoes (nome) VALUES ($1)`, [migracao.nome]);
      console.log(`[Migração] ✅ ${migracao.nome} — aplicada com sucesso.`);
    } catch (err) {
      console.error(`[Migração] ❌ ${migracao.nome} — falhou:`, err);
      throw err;
    }
  }

  console.log('[Migração] Concluída.');
  await fecharConexao();
}

migrar().catch((err) => {
  console.error('[Migração] Erro fatal:', err);
  process.exit(1);
});
