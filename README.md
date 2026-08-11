# sport_track_api — 运动轨迹后端服务

> 版本：v0.1（M1 骨架：登录鉴权 + OSS STS 已可运行）
> 项目文档：`../sport_track_miniapp/docs/`

## 技术栈

- **TypeScript + Fastify 5 + Mongoose 9**（决策 D10）
- 数据库：MongoDB（本地/线上已有实例，新建独立库 `sport-track-dev`）
- 校验：zod（请求参数强校验）
- 文件存储：阿里云 OSS **AK 签名直传**（后端签发 policy/signature，无需 RAM 角色；决策 D12）
- 内容安全：**微信 msgSecCheck / imgSecCheck**（昵称、图片上传前合规检测，未配置降级放行）
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

## API 一览（M1 + M2 已实现）

### 认证与用户
| 方法 | 路径 | 说明 | 鉴权 |
|---|---|---|---|
| POST | `/api/auth/login` | 微信 code → openid → 查/建用户 → JWT | 无 |
| POST | `/api/auth/refresh` | refreshToken → 新 accessToken | 无 |
| GET | `/api/users/me` | 当前用户资料 | ✅ |
| PUT | `/api/users/me` | 更新昵称/头像/性别/设置（昵称合规检测） | ✅ |
| POST | `/api/users/check-image` | 图片合规检测（imgSecCheck，≤1MB，直传前调用） | ✅ |

### 运动记录（M2 核心同步协议）
| 方法 | 路径 | 说明 | 鉴权 |
|---|---|---|---|
| POST | `/api/activities` | 创建进行中活动 | ✅ |
| POST | `/api/activities/:id/points` | 增量上传轨迹点（按 seq 幂等去重） | ✅ |
| POST | `/api/activities/:id/markers` | 新增打点（运动中） | ✅ |
| PUT | `/api/activities/:id/markers/:markerId` | 编辑打点（结束后可补编辑，坐标不可改） | ✅ |
| DELETE | `/api/activities/:id/markers/:markerId` | 删除打点（同步清理 OSS 照片） | ✅ |
| PUT | `/api/activities/:id/finish` | 结束：final 包对账 + 服务端重算指标 | ✅ |
| PUT | `/api/activities/:id/cancel` | 放弃活动 | ✅ |
| GET | `/api/activities` | 列表（分页 + 类型/月份筛选，含 pointsCount/markerCount/首尾点） | ✅ |
| GET | `/api/activities/:id` | 详情（完整点集 + 打点） | ✅ |
| GET | `/api/activities/:id/gpx` | 导出 GPX（markers 作航点） | ✅ |
| DELETE | `/api/activities/:id` | 删除（同步清理打点照片 OSS 文件） | ✅ |

### 统计与其他
| 方法 | 路径 | 说明 | 鉴权 |
|---|---|---|---|
| GET | `/api/stats/overview` | 今日/本周/本月/累计聚合 | ✅ |
| GET | `/api/stats/trend` | 近 7/30 天距离与时长（补零） | ✅ |
| POST | `/api/oss/credential` | 签发 OSS 直传签名凭证（policy+signature） | ✅ |
| GET | `/health` | 健康检查 | 无 |

## 里程碑进度

- [x] M1：Fastify 骨架、MongoDB 连接建库、微信登录 + JWT、OSS STS、Docker 化
- [x] M2：运动记录核心（活动 CRUD + 增量上传幂等同步 + finish 对账 + GPX 导出 + 统计聚合）
- [x] M3 后端：打点管理（编辑/删除 + OSS 照片清理）
- [x] 内容安全：昵称/图片微信合规检测
- [ ] M3 前端：小程序轨迹列表/详情/回放 + 打点交互
- [ ] M4：小程序码、分享
- [ ] M5：打磨发布
