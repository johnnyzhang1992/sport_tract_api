# sport_track_api — 运动轨迹后端服务

> 版本：v0.1（M1 骨架：登录鉴权 + OSS STS 已可运行）
> 项目文档：`../sport_track_miniapp/docs/`

## 技术栈

- **TypeScript + Fastify 5 + Mongoose 9**（决策 D10）
- 数据库：MongoDB（本地/线上已有实例，新建独立库 `sport-track-dev`）
- 校验：zod（请求参数强校验）
- 文件存储：阿里云 OSS **STS 临时凭证直传**（决策 D12）
- 鉴权：JWT（access 7 天 + refresh 30 天静默续期，决策 D14）
- 包管理：**pnpm**
- 部署：云服务器 + Docker（仅后端容器，决策 D11）

## 快速开始

```bash
pnpm install

# 1. 复制环境变量模板并填写（本地 MongoDB 需认证连接串）
cp .env.example .env.local
# 例：MONGODB_URI=mongodb://root:<密码>@127.0.0.1:27017/sport-track-dev?authSource=admin

# 2. 本地开发无真实微信 AppID 时，开启 mock 登录
# .env.local 中设置 WX_MOCK_LOGIN=true（任意 code 换测试 openid）

# 3. 启动开发服务（端口 3004，热重载）
pnpm dev
```

验证：

```bash
curl http://localhost:3004/health
# {"status":"ok","mongodb":true,"timestamp":"..."}

# 登录（mock 模式）
curl -X POST http://localhost:3004/api/auth/login \
  -H 'Content-Type: application/json' -d '{"code":"any-code"}'
```

## 脚本

| 命令 | 说明 |
|---|---|
| `pnpm dev` | 开发模式（tsx watch，端口 3004） |
| `pnpm build` | 编译到 dist/（tsc） |
| `pnpm start` | 运行编译产物（生产） |
| `pnpm test` | 接口测试（node:test + fastify.inject，需本地 MongoDB） |
| `pnpm typecheck` | 类型检查（src + test） |

## 环境变量

见 `.env.example`。关键项：

| 变量 | 说明 |
|---|---|
| `MONGODB_URI` | MongoDB 连接串（含认证） |
| `JWT_SECRET` / `JWT_REFRESH_SECRET` | access/refresh token 密钥（生产必须更换） |
| `WX_APPID` / `WX_SECRET` | 微信小程序凭据（公众平台） |
| `WX_MOCK_LOGIN` | 开发期 mock 登录开关（无需真实 AppID） |
| `OSS_REGION/BUCKET/ENDPOINT/AK_ID/AK_SECRET/ROLE_ARN` | 阿里云 OSS + STS 角色 |
| `CORS_ORIGIN` | 生产环境跨域白名单 |

## 目录结构

```
sport_track_api/
├── src/
│   ├── server.ts            # 启动入口
│   ├── app.ts               # 组装 Fastify 应用（插件 + 路由，测试复用）
│   ├── config/              # 环境变量加载、业务常量（运动类型/MET 系数）
│   ├── plugins/             # mongodb / jwt / error-handler 插件
│   ├── models/              # user / activity 模型（Mongoose）
│   ├── services/            # wechat（code2session）/ oss（STS 签发）
│   ├── routes/              # auth / user / oss 路由
│   ├── utils/               # app-error / response / validators
│   └── types/               # Fastify 装饰器类型声明
├── test/                    # 接口测试（node:test + fastify.inject）
├── Dockerfile               # 多阶段构建
├── docker-compose.yml       # 仅后端；MongoDB 走外部连接串
└── pnpm-workspace.yaml      # 依赖构建脚本白名单
```

## API 一览（M1 已实现）

| 方法 | 路径 | 说明 | 鉴权 |
|---|---|---|---|
| POST | `/api/auth/login` | 微信 code → openid → 查/建用户 → JWT | 无 |
| POST | `/api/auth/refresh` | refreshToken → 新 accessToken | 无 |
| GET | `/api/users/me` | 当前用户资料 | ✅ |
| PUT | `/api/users/me` | 更新昵称/头像/性别/设置 | ✅ |
| POST | `/api/oss/sts` | 签发 OSS 直传临时凭证（目录按 userId 隔离） | ✅ |
| GET | `/health` | 健康检查（含 MongoDB 状态） | 无 |

## 里程碑进度

- [x] M1：Fastify 骨架、MongoDB 连接建库、微信登录 + JWT、OSS STS、Docker 化
- [ ] M2：运动记录核心（活动 CRUD + 增量上传同步 + finish 对账）
- [ ] M3：打点 + 轨迹管理
- [ ] M4：统计聚合、GPX 导出、小程序码
- [ ] M5：打磨发布
