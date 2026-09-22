/** 启动时执行建表迁移（幂等）。DDL 内嵌，容器构建无需拷贝 .sql 资源。 */
import pg from 'pg';
import { config } from '../config.js';

export const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS batches (
  id          UUID PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  note        TEXT
);

CREATE TABLE IF NOT EXISTS records (
  id          UUID PRIMARY KEY,
  batch_id    UUID NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  status      TEXT NOT NULL CHECK (status IN ('ok', 'rejected')),
  input       JSONB NOT NULL,
  result      JSONB,
  errors      JSONB NOT NULL DEFAULT '[]',
  UNIQUE (batch_id, idx)
);

CREATE INDEX IF NOT EXISTS idx_records_batch ON records (batch_id, idx);
`;

export async function runMigrations(connectionString: string = config.databaseUrl): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(SCHEMA_DDL);
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => {
      console.log('migrations applied');
    })
    .catch((err) => {
      console.error('migration failed', err);
      process.exit(1);
    });
}
