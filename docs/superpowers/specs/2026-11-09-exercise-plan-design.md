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

---

## 2026-11-12 修订：结算边界、目标冻结、闲置取消

### 1. 结算边界（不造「计划开始之前」的假历史）

问题：`finalizePlanPeriod` 只看当前目标 + 窗口内轨迹，不看计划何时开始。用户今天新建「每天」计划，下一次结算就会给**昨天**补一条快照，把计划不存在时的运动算成「已达成」，达成率/里程碑/加量判断全被带偏。

修法：新增计划生效起点 `periodStart.activeFrom` / `ExercisePlan.activeFrom`，`finalizePlanPeriod` 在 `windowStart < planActiveFrom(doc)` 时直接返回 `null`（不写快照）。

`planActiveFrom` 回退链：`activeFrom`（新计划 / 切换周期类型时写入当天 0 点）→ `periodStart`（存量周计划锚点）→ `createdAt` 当天（存量每天计划）。

### 2. 目标首次冻结（改计划不改写历史）

问题：快照用 `$set` 连 `targets` 一起写，而 `/plan/current` 每次打开都 fire-and-forget 调 `finalizePreviousPeriod` — 等于每天重算上一期。用户把目标从 5km 改成 10km 后，昨天的快照被按新目标重算，「已达成」翻成「未达成」。

修法：`targets` 改为 `$setOnInsert`（只在首次结算时写入）；重结算只更新 `progress / achieved / allAchieved`，达成与目标都按**当时冻结**的目标判断。

### 3. 闲置取消（超过一个周期且 > 7 天没有运动）

规则：`now - max(计划生效起点, 最近一次运动时间) > max(一个周期, 7 天)` → 计划自动取消（删除计划文档，历史快照保留）。用户下次进计划页就是「无计划」态，重新走创建引导。

- 判定时机：`getPlan()` 读取时懒判定（用户回来那一刻生效），不开新 job
- 刚建计划还没运动不会误杀（起点＝建计划那天）
- 取消前若「刚结束的那一期」里有真实运动，先落一条快照再删（不让取消抹掉已发生的成绩）；空期不写
- 参数：`PLAN_IDLE_DAYS = 7`（`exercise-plan.ts`）

### 测试

- `EP17` 计划创建之前的窗口不落快照；`EP18` 改目标后重结算不重写历史目标与达成
- `EP19` 闲置 9 天取消且快照保留；`EP20` 刚建/3 天前有运动不取消；`EP21` 取消前补含运动的上一期、空期不写
