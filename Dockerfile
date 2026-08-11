# 构建阶段
FROM node:22-alpine AS builder
WORKDIR /app
# 用 npm 显式安装 pnpm（corepack 每次构建重新下载易失败），国内镜像加速
# store-dir 放 /tmp：规避 pnpm sqlite store 在 Docker overlay fs 上的 disk I/O error
RUN npm install -g pnpm@11 --registry=https://registry.npmmirror.com
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --registry=https://registry.npmmirror.com --store-dir=/tmp/pnpm-store
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# 运行阶段
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN npm install -g pnpm@11 --registry=https://registry.npmmirror.com
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile --registry=https://registry.npmmirror.com --store-dir=/tmp/pnpm-store && pnpm store prune
COPY --from=builder /app/dist ./dist
EXPOSE 3004
CMD ["node", "dist/server.js"]
