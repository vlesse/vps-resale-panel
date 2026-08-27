# 后端镜像。
#
# 分三段构建，为的是让最终镜像里只留运行时真正需要的东西：
#   deps     只装生产依赖（不含 TypeScript、Jest、Nest CLI 这些）
#   builder  装全部依赖并把 TypeScript 编译成 JavaScript
#   最终     从 deps 拿 node_modules，从 builder 拿编译产物
#
# 少了 deps 这一段的话，最终镜像会把整个 monorepo 的 node_modules
# （含前端的依赖和所有开发依赖）一起打进去，体积会到 1 GB 以上 ——
# 对一台 20 GB 磁盘的小服务器来说太浪费了。

# ---------- 生产依赖 ----------
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# openssl 是 Prisma 需要的
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
COPY apps/api/package.json ./apps/api/
RUN npm ci --omit=dev --workspace apps/api --include-workspace-root \
    || npm install --omit=dev --workspace apps/api --include-workspace-root

# Prisma 客户端必须针对这份 node_modules 生成，不能从 builder 拷过来
COPY apps/api/prisma ./apps/api/prisma
RUN npx prisma generate --schema apps/api/prisma/schema.prisma

# ---------- 编译 ----------
FROM node:22-bookworm-slim AS builder
WORKDIR /app

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

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/package.json ./apps/api/
COPY --from=builder /app/apps/api/prisma ./apps/api/prisma

EXPOSE 3000

# 每次启动先把数据库表结构同步一遍。第一次部署时它负责建表，
# 以后升级时它负责加新字段 —— 用户不需要懂什么是数据库迁移。
CMD ["sh", "-c", "npx prisma db push --schema apps/api/prisma/schema.prisma --accept-data-loss && node apps/api/dist/main.js"]
