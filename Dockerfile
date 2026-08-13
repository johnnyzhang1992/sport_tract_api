# 构建阶段
FROM node:22-alpine AS builder
WORKDIR /app
# npm 构建（规避 pnpm sqlite store 在部分 Docker overlay fs 上的 disk I/O error）
COPY package.json package-lock.json ./
RUN npm ci --registry=https://registry.npmmirror.com
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# 运行阶段
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --registry=https://registry.npmmirror.com && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY data ./data
EXPOSE 3004
CMD ["node", "dist/server.js"]
