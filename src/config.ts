/** 运行配置：存储后端、端口、数据库连接串，全部可经环境变量覆盖。 */

export interface AppConfig {
  port: number;
  host: string;
  /** postgres 使用 PostgreSQL；memory 使用进程内内存（默认，测试与无数据库时） */
  storage: 'memory' | 'postgres';
  databaseUrl: string;
}

export const config: AppConfig = {
  port: Number(process.env.PORT ?? 8080),
  host: process.env.HOST ?? '0.0.0.0',
  storage: (process.env.STORAGE ?? 'memory') === 'postgres' ? 'postgres' : 'memory',
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://symcomp:symcomp@localhost:5432/symcomp',
};
