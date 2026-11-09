# 每周运动数据站内通知兜底 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每周运动数据订阅消息在微信之外，同步写一条站内定向通知到消息中心（微信失败也有保底）。

**Architecture:** 在 `runWeeklySportsReminders` 逐用户循环中，noData 过滤后先写站内（dedupeKey 幂等），再走原有微信流程（零改动）。站内与微信结果解耦。

**Tech Stack:** Fastify + Mongoose（复用 `createNotification` / notifications partial unique 索引）、node:test。

## Global Constraints

- 收件人＝扫描范围内有额度且有上周数据的用户；**不广播**（`userId` 必填定向）。
- `dedupeKey = weeklySports:inapp:{userId}:{weekKey}`；每周每用户一条站内。
- 微信链路语义零改动：额度消费 / 43101 作废 / 网络错误删占位重试，均维持原状。
- 不动 `member-reminder.ts`、`admin-daily-stats.ts`、小程序端。
- 不做历史补发（订阅功能未上线）。
- 测试命令：`WX_MOCK_LOGIN=true node --import tsx --test --test-concurrency=1 test/weekly-sports-reminder.test.ts`（共享 dev 库，清理必须按前缀/本夹具 id，禁止 `deleteMany({})`）。

---

### Task 1: 站内通知写入（TDD）

**Files:**
- Modify: `src/services/weekly-sports-reminder.ts`
- Modify: `test/weekly-sports-reminder.test.ts`

**Interfaces:**
- Consumes: `createNotification(input: NotificationInput, dedupeKey?: string)`（`src/services/notification.ts`，撞 dedupeKey 返回既有行不抛错）；`NotificationModel`（`src/models/notification.model.ts`）；`fmtCnDateTime`（本文件已 import）。
- Produces: `WeeklySportsRunResult` 增加 `inapp: number`；循环内新增私有 `weeklyInappDedupeKey(userId: string, weekKey: string): string` 与 `weeklyInappContent(data: WeeklySportsData): string`（不导出，测试经 DB 断言）。

- [ ] **Step 1: 写失败测试**

在 `test/weekly-sports-reminder.test.ts`：

1. 顶部 import 增加 `NotificationModel`（`../src/models/notification.model.js`）。
2. `beforeEach` 增加：`await NotificationModel.deleteMany({ dedupeKey: { $regex: '^weeklySports:inapp:' } });`
3. `after`（首段清理区）增加同样的删除。
4. WS-3（成功路径）末尾追加断言：

```ts
  // 站内保底：微信成功也应有站内通知
  assert.equal(r.inapp, 1);
  const inapp = await NotificationModel.findOne({ dedupeKey: `weeklySports:inapp:${uid}:2026-W46` }).lean();
  // 注意：夹具 NOW=2026-11-09 当周 ISO 周标签按 bjIsoWeekLabel(WEEK_START) 断言，勿写死
  assert.ok(inapp, '站内通知已写入');
  assert.equal(inapp?.title, '每周运动数据');
  assert.equal(inapp?.category, 'system');
  assert.ok(String(inapp?.content).includes('上周跑步 5.00 公里'), String(inapp?.content));
  assert.ok(String(inapp?.content).includes('最近一次'), String(inapp?.content));
```

（weekKey 用 `bjIsoWeekLabel(WEEK_START)` 变量拼，不写死 W46。）

5. WS-5（43101 路径）追加：`assert.equal(?(await NotificationModel.exists({ dedupeKey: inappKeyOf(uid) })), true, '微信 43101 站内仍写入')` 与 `r.inapp === 1`。
6. WS-6（网络异常路径）追加：断言站内已写入；重跑后站内仍只有 1 条（幂等）、微信重试成功。
7. WS-4（noData）追加：`assert.equal(await NotificationModel.countDocuments({ dedupeKey: { $regex: '^weeklySports:inapp:' } }), 0, '空数据不发站内')`。
8. 新增 WS-10（无 openid + 幂等）：

```ts
test('WS-10 站内保底：无 openid 也发站内；同周重跑站内不重复', async () => {
  await setWeeklySportsSettings({ enabled: true, templateId: 'TPL_WEEKLY' });
  await recordWeeklySportsGrant(uid, 'message_center');
  await mkActivity({ startTime: at(3, 8, 0) });
  await UserModel.updateOne({ _id: new mongoose.Types.ObjectId(uid) }, { $unset: { openid: 1 } });

  const r = await runWeeklySportsReminders(NOW, { onlyUserIds: [uid] });
  assert.equal(r.inapp, 1, '无 openid 也写站内');
  assert.equal(r.skipped, 1, '微信跳过');
  assert.equal(sends.length, 0);

  const again = await runWeeklySportsReminders(NOW, { onlyUserIds: [uid] });
  assert.equal(again.inapp, 0, '重跑不重复写站内');
  assert.equal(await NotificationModel.countDocuments({ dedupeKey: { $regex: '^weeklySports:inapp:' } }), 1);

  // 还原 openid，避免污染共享库
  await UserModel.updateOne({ _id: new mongoose.Types.ObjectId(uid) }, { $set: { openid: OPENID } });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/johnnyzhang/extra_sport/sport_track_api && \
WX_MOCK_LOGIN=true node --import tsx --test --test-concurrency=1 test/weekly-sports-reminder.test.ts
```

预期：`r.inapp` undefined、站内查询为 null → WS-3/5/6/10 挂，WS-1/2/2b/4(noData 断言)/8/9 过。

- [ ] **Step 3: 实现最小改动**

`src/services/weekly-sports-reminder.ts`：

1. import 增加：
```ts
import { NotificationModel } from '../models/notification.model.js';
import { createNotification } from './notification.js';
```
2. `WeeklySportsRunResult` 增加 `inapp: number;`；`runWeeklySportsReminders` 开头 `const result: WeeklySportsRunResult = { sent: 0, noData: 0, inapp: 0, skipped: 0, failed: 0 };`
3. 循环前或工具区新增（不导出）：
```ts
function weeklyInappDedupeKey(userId: string, weekKey: string): string {
  return `weeklySports:inapp:${userId}:${weekKey}`;
}

function weeklyInappContent(data: WeeklySportsData): string {
  const latest = data.latest!;
  return `上周跑步 ${(data.runningMeters / 1000).toFixed(2)} 公里，运动 ${data.activeDays} 天；最近一次：${latestSummary(latest)}（${fmtCnDateTime(latest.startTime)}）`;
}
```
4. 循环内调整（noData 检查之后、openid 检查之前）：
```ts
    const list = byUser.get(userId);
    if (!list || list.length === 0) { result.noData += 1; continue; }
    const data = buildWeeklySportsData(summarizeWeeklySports(weekStart, weekEnd, list));

    // 站内保底：与微信结果解耦，有额度有数据就投（每周一条，dedupe 幂等）
    const inappKey = weeklyInappDedupeKey(userId, weekKey);
    if (!(await NotificationModel.exists({ dedupeKey: inappKey }))) {
      await createNotification({
        title: '每周运动数据', content: weeklyInappContent(data),
        category: 'system', published: true, userId: new Types.ObjectId(userId),
      }, inappKey);
      result.inapp += 1;
    }

    const openid = openidOf.get(userId);
    if (!openid) { result.skipped += 1; continue; }
    // ↓ 原微信流程原样保留（data 已在上方构建，删除循环内原 buildWeeklySportsData 行避免重复）
```

- [ ] **Step 4: 跑测试确认全绿**

同 Step 2 命令，全部 pass（含原有 10 个用例）。

- [ ] **Step 5: 全量回归**

```bash
cd /Users/johnnyzhang/extra_sport/sport_track_api && WX_MOCK_LOGIN=true npm test
```

已知无关失败：`werun-board.test.ts`（WB1/WB2/WB4，改动前即挂）。其余必须全绿。

- [ ] **Step 6: Commit**

```
feat(notify): 每周运动数据增加站内通知兜底（weeklySports:inapp 幂等，与微信结果解耦）
```

---

### Task 2: 部署生产

**Files:** 无代码改动；运维操作。

**Interfaces:**
- Consumes: Task 1 已合入 main 的镜像构建；`/Users/johnnyzhang/extra_sport/deploy/README.md` 日常更新流程。

- [ ] **Step 1: 构建 amd64 镜像**（必须在 `sport_track_api` 目录）

```bash
cd /Users/johnnyzhang/extra_sport/sport_track_api && \
docker build --platform linux/amd64 -t sport-track-api:latest . 2>&1 | tail -3 && \
docker save sport-track-api:latest | gzip -1 > /tmp/x.tgz && \
docker image inspect sport-track-api:latest --format '{{.Id}}'
```

- [ ] **Step 2: 上传加载（核对镜像 ID 一致）**

```bash
scp -o ConnectTimeout=10 /tmp/x.tgz root@124.220.54.45:/tmp/ && \
ssh root@124.220.54.45 "gunzip -c /tmp/x.tgz | docker load && rm /tmp/x.tgz && docker image inspect sport-track-api:latest --format '{{.Id}}'"
```

- [ ] **Step 3: 重建容器并健康检查**

```bash
ssh root@124.220.54.45 "cd /data/history-docker && docker compose up -d --no-build --force-recreate sport-track-api && sleep 5 && docker ps --format '{{.Names}}\t{{.Status}}' | grep sport-track-api && docker logs history-sport-track-api --since 1m 2>&1 | tail -5"
```

- [ ] **Step 4: 冒烟验证（不补发历史）**

确认容器无启动错误、日志无 `[weekly-sports]` 报错即可。真实投递验证留给下一个周一 09:00 后的扫描（订阅功能未上线，无需 force 补跑）。
