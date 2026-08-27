# 前端镜像。用 Next.js 的 standalone 输出，最终镜像里不含源码和开发依赖。

FROM node:22-bookworm-slim AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
COPY apps/web/package.json ./apps/web/
RUN npm ci --workspace apps/web --include-workspace-root || npm install --workspace apps/web --include-workspace-root

COPY apps/web ./apps/web
RUN npm run build --workspace apps/web

# ---------- 运行时 ----------
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public

EXPOSE 3000
CMD ["node", "apps/web/server.js"]
