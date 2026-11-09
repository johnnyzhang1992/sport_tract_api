# 运动榜上榜通知：定时投递 + 归类运动数据（设计）

日期：2026-11-09　状态：已确认

## 背景

上榜通知逻辑已存在（`notifyOnTheListOfBoards`，2026-11-05 裁定：周/月榜前 10 名含并列、每人每周期一条合并汇总、参与 ≤10 人的榜不发、已发到账/撤回通知者排除、settleFrom 闸门、dedupeKey 幂等），但只挂在懒结算上（用户访问积分/榜单页才触发，且发分开关关闭时懒结算整体不跑），实际收不到。

## 需求（用户确认）

1. **只发站内系统消息**，不做微信订阅消息。
2. **定时投递**：每周一发上周周榜；每月 1 日发上月月榜；发送时间 09:00（东八区）。
3. **多个榜单合并发送**（既有口径不变）。
4. **分类归「运动数据」（sports）**，不再用「榜单奖励」。
5. 文案调整：去掉「这一周」；明细行 `榜名：第 N 名`（去每行重复的周期后缀）；删「最高名次」行；标题改「运动榜上榜通知」。
6. 参与人数门槛沿用现有 ≤10 人口径。
7. **与发分开关解耦（二次确认）**：曾短暂改为「跟随开关」后用户撤销——关闸也发上榜通知，维持 2026-11-05 原口径。

## 设计

### points-board.ts（改）

- `ON_THE_LIST_TITLE = '运动榜上榜通知'`。
- `notifyOnTheListOfBoards`：`category: 'reward' → 'sports'`。
- `onTheListContent` 重写：
  - 单榜：`恭喜！你在「跑步榜」获得第 4 名` / 空行 / `统计周期：2026年10月` / `继续加油，下期继续冲榜！`
  - 多榜：`恭喜！你在本期榜单上榜 2 项` / 空行 / 逐榜 `散步榜：第 4 名`（按名次好→差排序）/ 空行 / `统计周期：…` / 加油行
  - 「统计周期」用 `boardLabel` 但去掉周末缀「这一周」（局部替换，不动 boardLabel 本体——它还被结算到账文案用，SP-6 两套形态不许互相统一）
- 懒结算路径保留不动（同函数同分类，幂等键挡重发，作漏发兜底）。

### board-onthelist-job.ts（新）

- 每小时 tick（首趟 60s 后），东八区闸门：周一 ≥09:00 → 上周周榜单元；每月 1 日 ≥09:00 → 上月月榜单元。
- 周单元：periodKey = 上周一东八日期串，endMs = `settleBoundaryMs('week', key)`；月单元：periodKey = `YYYY-MM`（上月），endMs = `settleBoundaryMs('month', key)`。
- 内存 done-set：同单元当天只聚合一次；聚合抛错则移出 done，下一 tick 重试（通知本身幂等）。
- 依赖缝 `onthelistJobDeps.notify`（默认 `notifyOnTheListOfBoards`），测试可替换。
- `NODE_ENV=test` 或 `BOARD_ON_THE_LIST_JOB=off` 不启动；`server.ts` 注册。

## 测试

- `onTheListContent` 新文案断言（单榜/多榜/「这一周」已去/排序）。
- `notifyOnTheListOfBoards` 落库 category = 'sports'（更新现有断言）。
- 任务模块：周一/1 号 08:59 不发、09:00 发；周二其余时刻不发；done-set 幂等；失败重试；lastWeek/lastMonth 单元键与窗口正确（含跨年 1 月）。
