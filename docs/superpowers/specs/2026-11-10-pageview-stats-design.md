# 页面访问量统计（PV/UV）设计 —— 待实施

> 状态：**已评审、暂缓实施**（2026-11-10 确认）。用户量不多，暂不处理；后期需要时按本文档直接开发，预计半小时。
> 结论依据：现有代码条件已全部确认齐备，无需额外调研。

## 需求

统计小程序内各页面的访问量：PV（浏览次数）、UV（去重用户数），按页面路径聚合，可按时间范围查询。

## 方案总览

轻量埋点：小程序端全局包装 `Page()` 自动上报，服务端一张集合逐条落库，TTL 自动过期，聚合接口出 PV/UV。

### 小程序端（1 个新文件 + app.js 加 3 行）

**新文件 `miniprogram/utils/pageview.js`**：

- `normalize(page)`：去掉 query、trim、截断 120 字符
- `report(page)`：fire-and-forget 调 `api.post('/stats/pageview', { page })`，`.catch(() => {})` 静默失败，绝不影响页面
- `instrumentPage(options)`：包装页面对象的 `onShow`——先 `report(this.route)` 再调原 onShow，返回新 options

**`app.js` 顶部加 3 行**（在任何页面注册前执行，分包页面同样覆盖）：

```js
const pv = require('./utils/pageview');
const __Page = Page;
Page = function (options) { return __Page(pv.instrumentPage(options)); };
```

要点（已确认）：
- 所有页面均为 `Page()` 写法，**无 Component 页面**，一处包装全覆盖，不改任何页面文件
- PV 口径 = 每次 onShow 计一次（从其他页面返回也计入，与常见统计口径一致）
- 游客（无 token）也上报，服务端按无主 PV 记录

### 服务端（1 个模型 + 2 个接口，挂 stats 前缀）

**新模型 `src/models/page-view.model.ts`**：

| 字段 | 类型 | 说明 |
|---|---|---|
| userId | ObjectId / null | 登录用户 ID；游客为 null |
| page | String | 页面路径（如 `pages/index/index`） |
| createdAt | Date | 浏览时间 |

索引：
- `{ page: 1, createdAt: -1 }`（聚合查询）
- `{ createdAt: 1 }` + TTL 180 天（自动过期，无需清理任务）

**接口（加在 `src/routes/stats.routes.ts`）**：

1. `POST /stats/pageview` —— 接收上报
   - 鉴权：`authenticateOptional`（已有装饰器，jwt.ts:58）——登录则记 userId，游客记 null
   - body：`{ page }` 单条 或 `{ pages: [{ page, ts? }] }` 批量（≤50 条）
   - 校验：page 经同样的 normalize（去 query、≤120 字符），非法直接丢弃（不报错，埋点不炸）

2. `GET /stats/pageview?days=30&limit=100` —— PV/UV 汇总
   - 鉴权：`{ onRequest: [fastify.authenticate, requireOperator] }`（与 operator 路由同款，`src/utils/operator-auth.ts`）
   - 聚合管道：match(createdAt ≥ since) → group by page（pv = sum 1，uv = addToSet userId）→ size(uv) → sort pv desc → limit
   - 返回 `[{ page, pv, uv }]`，按 PV 降序

## 数据量评估

按当前用户规模：一次页面浏览一条小记录（约 100B）。日均千级 PV → 月 3 万条、数 MB 内，TTL 180 天自动滚动，无压力。

## 测试计划

- API `test/pageview.test.ts`：
  - POST 单条/批量；游客（无 token）userId=null
  - 汇总：PV 计数、UV 去重、days 过滤、limit、仅运营者可查（普通用户 403）
- 小程序 `test/pageview-report.test.js`：
  - normalize 去 query/截断
  - instrumentPage 包装后 onShow 上报 `this.route` 且原 onShow 仍执行
  - report 对 api 异常静默吞掉

## 后续可选（不在首期）

- webAdmin 加一个「页面访问」页面，表格展示 PV/UV 排行（调同一接口）
- 运营者小程序端 `pages/operator` 加卡片
- 批量上报（客户端攒 10s/20 条合并成一次请求）——首期单条即可，量小不值得
- 渠道/场景值维度（options 里的 query 采集，需要脱敏）

## 相关代码位置（已确认）

| 依赖 | 位置 |
|---|---|
| 可选鉴权装饰器 | `src/plugins/jwt.ts` → `fastify.authenticateOptional` |
| 运营者守卫 | `src/utils/operator-auth.ts` → `requireOperator` |
| stats 路由注册 | `src/app.ts:98` → prefix `${config.apiPrefix}/stats` |
| 小程序网络层 | `miniprogram/services/api.js` → `post()` |
| 全局 Page 包装点 | `miniprogram/app.js` 顶部 |
