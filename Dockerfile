# syntax=docker/dockerfile:1

# ---- 构建阶段 ----
FROM node:20-bookworm-slim AS build
WORKDIR /app

# 先拷依赖清单以利用层缓存
COPY package.json package-lock.json* ./
RUN npm ci

# 编译 TypeScript
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# 去掉开发依赖，只留生产依赖
RUN npm prune --omit=dev

# ---- 运行阶段 ----
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# 非 root 用户运行
RUN groupadd -r symcomp && useradd -r -g symcomp symcomp

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

USER symcomp
EXPOSE 8080

# 简单的进程保活
CMD ["node", "dist/server.js"]
