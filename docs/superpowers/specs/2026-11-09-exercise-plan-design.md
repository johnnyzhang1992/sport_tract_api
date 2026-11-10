# 运动计划（苹果活动目标式三环）设计

日期：2026-11-10　状态：已确认（Q1=A 三环固定+超额封顶 / Q2=A 单计划二选一周期 / Q3=A 引导卡 / Q4=所有类型）

## 需求

- 三个可设置指标：运动距离（km）、运动时间（分钟）、运动次数（次），各设目标值，三环固定（Q1-A）
- 周期二选一：每天 / 每周（Q2-A）；完成度窗口＝当天 00:00 起 / 本周一 00:00 起（东八区）
- 超额完成：圆环封顶 100%，右侧数字显示实际值（可超目标）
- 完成度口径：当期**全部运动类型**的已完成轨迹合计（Q4）
- 首页运动类型区块上方新增卡片：左侧三同心环（canvas 2d），右侧三行「当前/目标」
- 无计划时显示引导卡（Q3-A），点击进计划设置页

## API

**模型** `exercise_plans`：`{ userId(唯一), period: 'daily'|'weekly', targets: { distanceM, durationMin, count }（米/分钟/次，均 ≥0）, createdAt, updatedAt }`

**路由**（新 `plan.routes.ts`，挂 `/plan`，均需登录）：
- `GET /plan/current`：计划（可 null）+ 当期进度 `{ distanceM, durationSec, count }` + 三环 `rings: [{ key, value, target, pct }]`（pct=min(1, v/t)，target≤0 时 pct=0）
- `PUT /plan`：`{ period, targets }` 校验：period 枚举；三项均为非负数且**至少一项 > 0**；上限（距离 ≤ 500km、时长 ≤ 10080 分钟=一周、次数 ≤ 999）；按 userId upsert

**进度聚合**：`ActivityModel.find({ userId, status:'finished', startTime ∈ 窗口 })` → Σdistance / Σduration / count。

## 小程序

- 新页 `pages/plan/plan`：周期分段选择 + 三项目标输入（距离 km 一位小数、时长/次数整数，均 >0）+ 保存（PUT 后返回）
- 首页卡（运动类型卡上方）：
  - 有计划：canvas 2d 三同心环（底环灰、进度弧顶部起顺时针、圆头线帽、超额封顶；配色 红#FA114F/绿#92E82A/青#1AD4E0）+ 右侧三行「距离 3.2/5 km · 时间 42/30 分钟 · 次数 2/1 次」
  - 无计划：引导卡「设定你的运动计划 / 坚持每天动一下 ›」
  - 点击进计划页；onShow TTL 批次 + 下拉刷新时 loadPlan
- canvas 细节：type=2d、dpr 缩放、三环半径 26/38/50px（外→内距离环最外），线宽 8px

## 测试

- API：upsert/校验（全零 400、非法周期 400、上限 400）/ 每日窗口进度 / 每周窗口进度（上周轨迹不计）/ 用户隔离 / 未登录 401
- 小程序：计划页表单校验；首页卡数据装载（有计划/无计划）
