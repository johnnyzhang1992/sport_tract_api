import { Types } from 'mongoose';
import { LoginLogModel } from '../models/login-log.model.js';
import { UserModel } from '../models/user.model.js';
import { WerunDayModel } from '../models/werun-day.model.js';
import { AppError } from '../utils/app-error.js';
import { activeMemberUserIds } from './entitlements.js';
import { getAvatarUrl } from './oss.js';

export const WERUN_BOARD_PERIODS = ['day', 'week', 'month', 'year'] as const;
export type WerunBoardPeriod = (typeof WERUN_BOARD_PERIODS)[number];

/** 榜单只出前 50 名（产品口径）；me 排名用全量分组，不受 50 限制 */
export const WERUN_BOARD_TOP = 50;

export interface WerunPeriodWindow {
  periodKey: string;
  startMs: number;
  endMs: number;
  /** 给用户看的区间文案：日=「2026年11月6日」，周=「2026/11/02 至 11/08」，月=「2026年11月」，年=「2026年」 */
  text: string;
}

export interface WerunRankRow {
  rank: number;
  name: string;
  /** 性别：0 未知 1 男 2 女 */
  gender: number;
  avatarUrl: string;
  avatarPreset: string;
  uid: number;
  memberActive: boolean;
  /** 该行用户开了隐私模式（对非本人查看者）：身份已匿名（昵称/头像/uid），步数照常展示；行不可点开资料卡 */
  privacy?: boolean;
  /** 该周期步数合计 */
  step: number;
}

export interface WerunBoardResult {
  period: WerunBoardPeriod;
  /** '全国' 或省份名 */
  province: string;
  /** 参与人数（周期内有步数数据的用户数） */
  players: number;
  top: WerunRankRow[];
  /** 当前用户真实排名（哪怕第 51 名之后也返回）；游客/无数据为 null */
  me: WerunRankRow | null;
  window: WerunPeriodWindow | null;
  prevPeriodKey: string | null;
  nextPeriodKey: string | null;
}

const DAY_MS = 86_400_000;
const BJ_MS = 8 * 3600_000;

/** 北京时区当天零点（毫秒） */
function bjMid(y: number, m: number, d: number): number {
  return Date.UTC(y, m - 1, d) - BJ_MS;
}

function bjParts(ms: number): { y: number; m: number; d: number } {
  const d = new Date(ms + BJ_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

function bjDateStr(ms: number): string {
  const p = bjParts(ms);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** 东八区自然周从周一开始 */
function bjIsoWeekStart(ms: number): number {
  const dow = new Date(ms + BJ_MS).getUTCDay(); // 0=周日
  const back = (dow + 6) % 7;
  const p = bjParts(ms);
  return bjMid(p.y, p.m, p.d) - back * DAY_MS;
}

/** 某周期「包含 anchor 的那一期」的起点 */
function periodStart(period: WerunBoardPeriod, anchorMs: number): number {
  const p = bjParts(anchorMs);
  if (period === 'day') return bjMid(p.y, p.m, p.d);
  if (period === 'week') return bjIsoWeekStart(anchorMs);
  if (period === 'month') return bjMid(p.y, p.m, 1);
  return bjMid(p.y, 1, 1);
}

function windowFromStart(period: WerunBoardPeriod, startMs: number): WerunPeriodWindow {
  const md = (p: { m: number; d: number }) => `${String(p.m).padStart(2, '0')}/${String(p.d).padStart(2, '0')}`;
  if (period === 'day') {
    const p = bjParts(startMs);
    return {
      periodKey: bjDateStr(startMs),
      startMs,
      endMs: startMs + DAY_MS,
      text: `${p.y}年${p.m}月${p.d}日`,
    };
  }
  if (period === 'week') {
    const endMs = startMs + 7 * DAY_MS;
    const s = bjParts(startMs);
    const e = bjParts(endMs - DAY_MS);
    return {
      periodKey: bjDateStr(startMs),
      startMs,
      endMs,
      text: s.y === e.y ? `${s.y}/${md(s)} 至 ${md(e)}` : `${s.y}/${md(s)} 至 ${e.y}/${md(e)}`,
    };
  }
  if (period === 'month') {
    const p = bjParts(startMs);
    return {
      periodKey: `${p.y}-${String(p.m).padStart(2, '0')}`,
      startMs,
      endMs: bjMid(p.y, p.m + 1, 1),
      text: `${p.y}年${p.m}月`,
    };
  }
  const p = bjParts(startMs);
  return { periodKey: String(p.y), startMs, endMs: bjMid(p.y + 1, 1, 1), text: `${p.y}年` };
}

/** 周期窗口：不传 periodKey＝包含 now 的那一期；历史周期入口传 key 反解 */
function periodWindow(period: WerunBoardPeriod, periodKey: string | undefined, now: number): WerunPeriodWindow {
  const key = String(periodKey || '').trim();
  if (!key) return windowFromStart(period, periodStart(period, now));
  if (period === 'day' || period === 'week') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new AppError(400, `${period === 'day' ? '日' : '周'}榜周期键应为 YYYY-MM-DD（收到「${key}」）`);
    const start = bjMid(Number(key.slice(0, 4)), Number(key.slice(5, 7)), Number(key.slice(8, 10)));
    if (bjDateStr(start) !== key) throw new AppError(400, `${period === 'day' ? '日' : '周'}榜周期键不是合法日期（收到「${key}」）`);
    if (period === 'week' && bjIsoWeekStart(start) !== start) {
      throw new AppError(400, `周榜周期键必须是周一（收到「${key}」）`);
    }
    return windowFromStart(period, start);
  }
  if (period === 'month') {
    const m = /^(\d{4})-(\d{2})$/.exec(key);
    if (!m) throw new AppError(400, `月榜周期键应为 YYYY-MM（收到「${key}」）`);
    const month = Number(m[2]);
    if (month < 1 || month > 12) throw new AppError(400, `月榜周期键月份非法（收到「${key}」）`);
    return windowFromStart('month', bjMid(Number(m[1]), month, 1));
  }
  if (!/^\d{4}$/.test(key)) throw new AppError(400, `年榜周期键应为 YYYY（收到「${key}」）`);
  return windowFromStart('year', bjMid(Number(key), 1, 1));
}

/** 相邻期翻页键；下一期还没开始（本期未结束）时 next 为 null */
function adjacentKeys(period: WerunBoardPeriod, win: WerunPeriodWindow, now: number) {
  const prev = windowFromStart(period, periodStart(period, win.startMs - 1));
  const nextInFuture = win.endMs > now;
  const next = nextInFuture ? null : windowFromStart(period, periodStart(period, win.endMs));
  return { prevPeriodKey: prev.periodKey, nextPeriodKey: next ? next.periodKey : null };
}

/**
 * 用户 → 最近一次登录省份 的映射（60s 内存缓存：省份归属随登录漂移，短窗口内允许略旧）。
 * 省份口径与「我的」资料/管理端一致：最新一条登录日志的归属地。
 */
interface ProvinceIndex {
  /** userId(string) → 省份（非空） */
  byUser: Map<string, string>;
  /** 有用户的省份（人数降序），供省份选择器 */
  list: { name: string; users: number }[];
}
let provinceCache: { at: number; data: ProvinceIndex } | null = null;
async function latestLoginProvinces(): Promise<ProvinceIndex> {
  if (provinceCache && Date.now() - provinceCache.at < 60_000) return provinceCache.data;
  const logs = await LoginLogModel.aggregate<{ _id: unknown; province: string | null }>([
    { $sort: { createdAt: -1 } },
    { $group: { _id: '$userId', province: { $first: '$province' } } },
  ]);
  const byUser = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const log of logs) {
    const p = (log.province || '').trim();
    // 定位服务对某些 IP 会回「0」这类占位值：既不是省份也不该进选择器
    if (!p || /^\d+$/.test(p)) continue;
    byUser.set(String(log._id), p);
    counts.set(p, (counts.get(p) || 0) + 1);
  }
  const data: ProvinceIndex = {
    byUser,
    list: [...counts.entries()]
      .map(([name, users]) => ({ name, users }))
      .sort((a, b) => b.users - a.users),
  };
  provinceCache = { at: Date.now(), data };
  return data;
}

/** 省份选择器数据：全国 + 有登录记录的省份（人数降序） */
export async function werunBoardProvinces(): Promise<{ provinces: { name: string; users: number }[] }> {
  const { list } = await latestLoginProvinces();
  return { provinces: list };
}

/**
 * 微信步数排行榜：day/week/month/year 四种周期，全国或按省（用户最近登录省份），TOP50 + 我的排名。
 * 聚合与运动榜同一思路：全量分组后内存排序（步数数据量级小，无需 $rank）。
 */
export async function werunBoard(
  /** 当前用户 id（可选鉴权；游客为 null，me 返回 null） */
  userId: string | null,
  period: string,
  opts: { province?: string; periodKey?: string; now?: number } = {},
): Promise<WerunBoardResult> {
  const { province = '全国', periodKey, now = Date.now() } = opts;
  if (!WERUN_BOARD_PERIODS.includes(period as never)) {
    throw new AppError(400, '榜单周期不合法');
  }
  const p = period as WerunBoardPeriod;
  const win = periodWindow(p, periodKey, now);

  // 省份过滤：先把该省（最近登录口径）的用户 id 集合拿出来，再进聚合——
  // 比聚合后 $lookup 再过滤少一次全量 join；该省没人同步过步数时直接空榜。
  // 注意 byUser 的 key 是字符串，$in 必须转回 ObjectId（Mongo 不做跨类型匹配，字符串恒不命中）
  let userIdFilter: Types.ObjectId[] | null = null;
  if (province && province !== '全国') {
    const { byUser } = await latestLoginProvinces();
    userIdFilter = [...byUser.entries()]
      .filter(([, prov]) => prov === province)
      // 守卫：登录日志理论上 userId 必有，但脏行（历史导入/手工写）里的非 ObjectId 串会让
      // new Types.ObjectId 直接抛，把一个公开榜单接口打成 500——这里跳过而不是崩。
      .filter(([id]) => Types.ObjectId.isValid(id))
      .map(([id]) => new Types.ObjectId(id));
    if (userIdFilter.length === 0) {
      return {
        period: p,
        province,
        players: 0,
        top: [],
        me: null,
        window: win,
        ...adjacentKeys(p, win, now),
      };
    }
  }

  // date 是 YYYY-MM-DD 字符串，字典序即时间序，直接字符串区间
  // （用 bjDateStr（毫秒口径）换算——werunDateOf 是秒口径，喂毫秒会算出几万年外）
  const rows = await WerunDayModel.aggregate<{ _id: unknown; step: number }>([
    {
      $match: {
        date: { $gte: bjDateStr(win.startMs), $lt: bjDateStr(win.endMs) },
        ...(userIdFilter ? { userId: { $in: userIdFilter } } : {}),
      },
    },
    { $group: { _id: '$userId', step: { $sum: '$step' } } },
    // 次级键 _id 升序：同一步数时名次稳定可重放（否则每次查询顺序不保证，排名会跳）
    { $sort: { step: -1, _id: 1 } },
  ]);

  const myIdx = userId ? rows.findIndex((r) => String(r._id) === String(userId)) : -1;
  const topRows = rows.slice(0, WERUN_BOARD_TOP);
  const meRow = myIdx >= 0 ? rows[myIdx] : null;

  const involvedIds = [...new Set([...topRows.map((r) => String(r._id)), ...(meRow ? [String(meRow._id)] : [])])];
  const users = await UserModel.find({ _id: { $in: involvedIds } })
    .select({ uid: 1, nickname: 1, gender: 1, avatarUrl: 1, avatarPreset: 1, 'settings.privacyMode': 1 })
    .lean();
  const infoById = new Map(
    users.map((u) => [
      String(u._id),
      {
        uid: Number(u.uid) || 0,
        nickname: u.nickname || '',
        gender: u.gender ?? 0,
        avatarUrl: u.avatarUrl ? getAvatarUrl(u.avatarUrl) : '',
        avatarPreset: u.avatarPreset || '',
        privacy: u.settings?.privacyMode === true,
      },
    ]),
  );
  const memberIds = await activeMemberUserIds(involvedIds);

  // 隐私模式（2026-11-09，口径修订）：仅隐藏身份（昵称→隐私用户、头像/性别/会员徽标清空、
  // uid 置 0 不可点开资料卡）；步数照常展示。
  const toRow = (r: { _id: unknown; step: number }, rank: number): WerunRankRow => {
    const info = infoById.get(String(r._id));
    const anonymize = !!info && info.privacy && String(r._id) !== String(userId);
    if (anonymize) {
      return {
        rank, uid: 0, name: '隐私用户', gender: 0, avatarUrl: '', avatarPreset: '',
        memberActive: false, step: r.step, privacy: true,
      };
    }
    return {
      rank,
      uid: (info && info.uid) || 0,
      name: (info && info.nickname) || '运动用户',
      gender: (info && info.gender) || 0,
      avatarUrl: (info && info.avatarUrl) || '',
      avatarPreset: (info && info.avatarPreset) || '',
      memberActive: memberIds.has(String(r._id)),
      step: r.step,
    };
  };

  return {
    period: p,
    province,
    players: rows.length,
    top: topRows.map((r, i) => toRow(r, i + 1)),
    me: meRow ? toRow(meRow, myIdx + 1) : null,
    window: win,
    ...adjacentKeys(p, win, now),
  };
}
