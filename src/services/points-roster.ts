/**
 * 免广告名单：微信没有「按用户写广告屏蔽名单」的 API，只能管理员在 We分析 上传人群包，且次日生效。
 * 所以这个接口必须下发 openid —— 它是全后台唯一允许出现 openid 的出口（RS-3 钉住），
 * 每次返回的是「当天有效」的全量名单，替换上传而不是追加（卡过期的人不会自动掉出名单）。
 *
 * 推导口径与 `adFreeUntilOf` 共用 `points-cards.replayAdFree`（spec §5.4）：
 * 按 activatedAt 升序逐张顺延、空窗不追溯。这里绝不另写一份 `Math.max(...) + benefitDays * DAY`
 * —— 两份算术各坏一份时，Task 3 与本文件的用例总有一边会红。
 *
 * 为什么在 JS 里按用户分组重放而不是写进聚合管道：卡的条数极小（每个激活用户个位数），
 * 把「顺延叠加」翻译成 `$reduce` 只会让口径多一份不可读的副本。
 */
import { Types } from 'mongoose';
import { PointCardModel } from '../models/point.model.js';
import { UserModel } from '../models/user.model.js';
import { bjDateStr } from '../utils/bj-time.js';
import { replayAdFree } from './points-cards.js';

/** 名单行（spec §7.2）：导出人群包需要 openid + 到期日，后台展示需要 uid/昵称 */
export interface RosterRow {
  openid: string;
  uid: number;
  nickname: string;
  /** 权益到期时刻（epoch ms），与端上 /points/summary 的 adFreeUntil 同一口径 */
  adFreeUntil: number;
  /** 到期时刻的东八区日期串（YYYY-MM-DD）：人群包按天生效，上传时给人看的就是这一天 */
  adFreeUntilDate: string;
}

/**
 * 当天有效的免广告权益：userId → 到期时刻。
 * 只扫「已激活且权益天数 > 0」的卡（补签卡 benefitDays=0 天然被排除），
 * 按 activatedAt 升序喂给 replayAdFree，再过滤 until > now。
 */
async function activeAdFree(now: number): Promise<Map<string, number>> {
  const cards = await PointCardModel.find({ status: 'used', benefitDays: { $gt: 0 } })
    .select({ userId: 1, activatedAt: 1, benefitDays: 1 })
    .sort({ userId: 1, activatedAt: 1, _id: 1 })
    .lean();

  const grouped = new Map<string, Array<{ activatedAt: number; benefitDays: number }>>();
  for (const c of cards) {
    const userId = String(c.userId);
    const list = grouped.get(userId);
    const one = { activatedAt: Number(c.activatedAt ?? 0), benefitDays: Number(c.benefitDays ?? 0) };
    if (list) list.push(one); else grouped.set(userId, [one]);
  }

  const active = new Map<string, number>();
  for (const [userId, list] of grouped) {
    // 查询已按 userId, activatedAt, _id 排序 ⇒ 每组天然满足 replayAdFree 的输入顺序
    const until = replayAdFree(list);
    if (until > now) active.set(userId, until);
  }
  return active;
}

/** 免广告名单（GET /points/ad-free/roster）：只含当天有效用户，按到期日倒序 */
export async function adFreeRoster(now = Date.now()): Promise<RosterRow[]> {
  const active = await activeAdFree(now);
  if (active.size === 0) return [];

  const users = await UserModel.find({ _id: { $in: [...active.keys()].map((id) => new Types.ObjectId(id)) } })
    .select({ openid: 1, uid: 1, nickname: 1 })
    .lean();

  const rows: RosterRow[] = [];
  for (const u of users) {
    const adFreeUntil = active.get(String(u._id));
    if (!adFreeUntil) continue; // 并发删除的用户：active 里刚被清掉，跳过
    const openid = String(u.openid ?? '');
    // 没有 openid 的行上传不了人群包，列表里也不该出现一条空 openid 的假行
    if (!openid) continue;
    rows.push({
      openid,
      // 与发放记录同口径：存量 uid 混着 int/string 两种 BSON 类型，一律 Number 归一
      uid: Number(u.uid ?? 0),
      nickname: String(u.nickname ?? ''),
      adFreeUntil,
      adFreeUntilDate: bjDateStr(adFreeUntil),
    });
  }

  // 到期日倒序；同日按 openid 升序兜底，保证两次请求的先后完全一致（导出 CSV 可复查）
  rows.sort((a, b) => b.adFreeUntil - a.adFreeUntil
    || (a.openid < b.openid ? -1 : a.openid > b.openid ? 1 : 0));
  return rows;
}
