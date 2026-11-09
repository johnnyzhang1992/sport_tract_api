# 每周运动数据：站内通知兜底（设计）

日期：2026-11-09　状态：已确认（方案 B）

## 背景与问题

2026-11-09 周一，每周运动数据微信订阅消息因 47003（character_string4 含中文）被拒收。
排查中发现该链路**没有站内兜底**：微信发送失败＝用户本周完全收不到周报。
对照另两条订阅消息链路：

- 会员到期提醒：站内仅作兜底（无微信额度 / 微信失败时）；
- 每日数据报告：站内无条件 + 微信加发。

本次 47003 已修复并部署（`character_string4` 改 `km` 后缀）。订阅功能尚未正式上线，**不做历史补发**。

## 需求（用户已确认）

1. 每周运动数据除微信推送外，同步发一条**站内定向通知**到消息中心。
2. 收件人＝扫描范围内**有订阅额度且有上周运动数据**的用户；不广播全员。
3. 站内与微信发送结果解耦（方案 B）：微信失败（43101 / 网络错误 / 字段错误）站内照发。
4. 会员到期提醒、每日数据报告维持现状（方案 B 不动）。

## 设计

### weekly-sports-reminder.ts

逐用户流程调整为：

1. 上周无已完成轨迹 → `noData`，整条跳过（微信/站内都不发，不变）；
2. 汇总周报数据（两通道共用）；
3. **写站内通知**（先于微信，站内是保底通道）：
   - `dedupeKey = weeklySports:inapp:{userId}:{weekKey}`（对齐 `memberExpiry:inapp:` 命名风格；唯一 partial 索引幂等）；
   - 写入前 `NotificationModel.exists({ dedupeKey })` 预检，存在即跳过（与 member/daily 同款防重写法，避免撞唯一索引抛错）；
   - `createNotification({ title: '每周运动数据', content, category: 'system', published: true, userId }, dedupeKey)`；
   - 正文：`上周跑步 5.20 公里，运动 3 天；最近一次：上周骑行 12.00 公里（11-06 08:30）`（复用 summarize/latestSummary/fmtCnDateTime 口径）；
   - 成功写入计入新计数 `inapp`；
4. 无 `openid` → `skipped`（站内已送达，仅微信跳过）；
5. 微信下发流程原样保留（额度消费 / 43101 作废 / 网络错误删占位重试，均不受影响）。

`WeeklySportsRunResult` 增加 `inapp: number`。

### 幂等与重入

- 站内按 `userId + weekKey` 每周一条，重跑预检跳过；
- 微信链路的 dedupe / 额度语义零改动；
- 单实例小时级串行扫描，exists 预检与创建之间的竞态窗口可忽略（与现有两条链路同等假设）。

### 不改动

- `member-reminder.ts`、`admin-daily-stats.ts`、小程序端（消息中心已支持定向行与 system 分类）、`notification.ts` 公共逻辑。

## 测试（weekly-sports-reminder.test.ts 增补）

1. 微信成功 → 站内存在，字段正确（title/content/category/定向 userId/dedupeKey）；
2. 微信 43101（额度作废）→ 站内仍写入；
3. 微信网络异常 → 站内仍写入，重跑微信可重试且站内不重复；
4. 无 openid → 站内写入、微信不计；
5. 上周无数据 → 无站内、无微信（断言补强）；
6. 同周重跑 → 站内不重复（幂等）。

## 验收

- 测试全绿；部署生产后下一个周一 09:00 起的扫描中，订阅者消息中心可见周报站内通知；
- 微信通道正常时用户双通道各收一条（站内未读 + 微信服务通知）。
