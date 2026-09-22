/** 服务入口：按配置选择 PostgreSQL 或内存存储，执行迁移后监听端口。 */

import { buildApp } from './app.js';
import { config } from './config.js';
import { InMemoryBatchRepository } from './persistence/memory.js';
import { PostgresBatchRepository } from './persistence/postgres.js';
import type { BatchRepository } from './persistence/repository.js';
import { runMigrations } from './db/migrate.js';

async function main(): Promise<void> {
  let repo: BatchRepository;
  if (config.storage === 'postgres') {
    await runMigrations();
    repo = new PostgresBatchRepository(config.databaseUrl);
  } else {
    repo = new InMemoryBatchRepository();
  }

  const app = await buildApp(repo);
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`symcomp service listening on ${config.host}:${config.port} (storage=${config.storage})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
