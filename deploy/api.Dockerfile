# 后端镜像。分两段构建：第一段装依赖和编译，第二段只留运行时需要的东西，
# 这样最终镜像小很多，服务器磁盘吃得少。

FROM node:22-bookworm-slim AS builder
WORKDIR /app

# openssl 是 Prisma 需要的
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 先只拷贝依赖清单，这样改代码不会导致重新下载全部依赖
COPY package.json package-lock.json* ./
COPY apps/api/package.json ./apps/api/
RUN npm ci --workspace apps/api --include-workspace-root || npm install --workspace apps/api --include-workspace-root

COPY apps/api ./apps/api
RUN npx prisma generate --schema apps/api/prisma/schema.prisma \
    && npm run build --workspace apps/api

# ---------- 运行时 ----------
FROM node:22-bookworm-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/package.json ./apps/api/
COPY --from=builder /app/apps/api/prisma ./apps/api/prisma

EXPOSE 3000

# 每次启动先把数据库表结构同步一遍。第一次部署时它负责建表，
# 以后升级时它负责加新字段 —— 用户不需要懂什么是数据库迁移。
CMD ["sh", "-c", "npx prisma db push --schema apps/api/prisma/schema.prisma --accept-data-loss && node apps/api/dist/main.js"]
