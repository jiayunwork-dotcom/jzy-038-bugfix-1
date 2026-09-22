/** Fastify 应用工厂：装配统一错误处理与路由，存储后端由调用方注入（便于测试）。 */

import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { registerRoutes } from './routes/records.js';
import type { BatchRepository } from './persistence/repository.js';

export async function buildApp(repo: BatchRepository): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error(error);
    // JSON 体解析失败等 -> 结构化 400，而不是 500
    if (error.statusCode === 400 || error.statusCode === 415) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_FAILED', message: error.message },
      });
    }
    return reply.status(error.statusCode ?? 500).send({
      error: { code: 'VALIDATION_FAILED', message: error.message },
    });
  });

  await registerRoutes(app, repo);

  app.addHook('onClose', async () => {
    await repo.close();
  });

  return app;
}
