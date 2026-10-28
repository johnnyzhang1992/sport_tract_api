/**
 * 签到月历接口（GET /points/signin/calendar）。
 *
 * 钉住四件事：
 * 1. 整月按天下发，状态与服务端唯一判据同源（不在端上再推一遍）；
 * 2. 「可补」只可能出现在 [今天-6, 昨天] 窗口内 —— 历史月份的漏签日必须是 missed，
 *    端上点它会由补签接口回 400（2026-10-28 用户拍板：不做端上禁用，但判据不能错标）；
 * 3. 未来日给的是名义推算分值（一路签下去能拿几分），不是 0；
 * 4. 参数闸门与登录闸门。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose, { Types } from 'mongoose';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { config } from '../src/config/index.js';
import { PointSigninModel } from '../src/models/point.model.js';
import { getSigninCalendar } from '../src/services/points-calendar.js';
import { bjDateStr } from '../src/utils/bj-time.js';
import { rewardForStreakDay, shiftDateKey } from '../src/utils/points-domain.js';

const API = '/sport-track/api';
const TODAY = bjDateStr(Date.now());

/** 上一个月的 YYYY-MM：按字符串退月，1 月要退到去年 12 月 */
function lastMonthKey(): string {
  const [y, m] = TODAY.slice(0, 7).split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}
const LAST_MONTH = lastMonthKey();
/** 上个月的第 1 天：距今天恒 ≥28 天，一定落在 7 天窗口外，是「历史漏签日」的稳定样本 */
const OLD_MISSED = `${LAST_MONTH}-01`;
/** 当月天数：断言 days 覆盖整月 */
const DAYS_IN_MONTH = new Date(Number(TODAY.slice(0, 4)), Number(TODAY.slice(5, 7)), 0).getDate();

let app: FastifyInstance;
let token = '';
let userId = '';
let uid: Types.ObjectId;

const auth = () => ({ authorization: `Bearer ${token}` });
const data = <T>(res: { json: () => { data: T } }): T => res.json().data;

interface CalendarDay {
  dateKey: string;
  state: 'signed' | 'today' | 'makeup' | 'missed' | 'future';
  streakDay: number;
  reward: number;
}
interface Calendar { month: string; today: string; days: CalendarDay[] }

const getCal = (month = '') =>
  app.inject({ method: 'GET', url: `${API}/points/signin/calendar${month ? `?month=${month}` : ''}`, headers: auth() });

const seed = (dateKey: string, streakDay: number) =>
  PointSigninModel.create({ userId: uid, dateKey, streakDay, points: Math.min(streakDay, 7), source: 'sign', createdAt: Date.now() });

const byKey = (c: Calendar, dateKey: string) => c.days.find((d) => d.dateKey === dateKey);

before(async () => {
  await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 5000 });
  await PointSigninModel.init();
  app = await buildApp({ logger: false });
  await app.ready();
  const login = await app.inject({
    method: 'POST',
    url: `${API}/auth/login`,
    payload: { code: `openid:points-calendar-${Date.now()}-${Math.random().toString(36).slice(2)}` },
  });
  assert.equal(login.statusCode, 200, login.body);
  const d = login.json().data;
  token = d.accessToken;
  userId = d.user?.id ?? d.user?._id;
  uid = new Types.ObjectId(userId);
});

after(async () => {
  await PointSigninModel.deleteMany({ userId: uid });
  await app.close();
  await mongoose.disconnect();
});

test('CAL-1 整月按天下发：已签取库存值、未来日给名义推算分', async () => {
  await PointSigninModel.deleteMany({ userId: uid });
  // 本月 3 号签到（库存第 4 天），今天没签
  const signedDay = `${TODAY.slice(0, 7)}-03`;
  await seed(signedDay, 4);

  const c = data<Calendar>(await getCal());
  assert.equal(c.month, TODAY.slice(0, 7), '缺省 month = 当月');
  assert.equal(c.today, TODAY);
  // 2026-10-28 改版：端上把首尾补位填成相邻月份的日期，所以服务端前后各多给 6 天，
  // 不然补位格只能画成「没签」的灰圈——上月 28 号签过也会说谎
  assert.equal(c.days.length, DAYS_IN_MONTH + 12, '当月 ± 6 天');
  assert.equal(c.days[0].dateKey, shiftDateKey(`${c.month}-01`, -6), '从补位首日按升序下发');
  assert.equal(c.days[c.days.length - 1].dateKey, shiftDateKey(`${c.month}-01`, DAYS_IN_MONTH + 5));
  assert.deepEqual(
    c.days.filter((d) => d.dateKey.startsWith(c.month)).map((d) => d.dateKey.slice(8)),
    Array.from({ length: DAYS_IN_MONTH }, (_, i) => String(i + 1).padStart(2, '0')),
    '当月每一天都必须在，且顺序不乱',
  );

  const s = byKey(c, signedDay)!;
  assert.equal(s.state, 'signed');
  assert.equal(s.streakDay, 4, '已签日下发库存 streakDay，不重算');
  assert.equal(s.reward, 4);

  const t = byKey(c, TODAY)!;
  assert.equal(t.state, 'today', '今天没签仍是 today 格（可点签到）');

  const tomorrow = byKey(c, shiftDateKey(TODAY, 1));
  if (tomorrow) {
    // 今天接上就是第 5 天，明天第 6 天：未来格是「一路签下去」的名义分值
    assert.equal(tomorrow.state, 'future');
    assert.equal(tomorrow.reward, rewardForStreakDay(t.streakDay + 1), '未来日按连签推算给分，不能是 0');
  }
});

test('CAL-2 可补只出现在窗口内；历史月份漏签日一律 missed', async () => {
  await PointSigninModel.deleteMany({ userId: uid });
  await seed(shiftDateKey(TODAY, -1), 6); // 昨天有行 → 窗口内漏签日才谈得上可补

  const cur = data<Calendar>(await getCal());
  const makeupKeys = cur.days.filter((d) => d.state === 'makeup').map((d) => d.dateKey);
  assert.ok(makeupKeys.length > 0, '昨天签了、今天之前有漏签日 → 至少有一格可补');
  const left = shiftDateKey(TODAY, -6);
  assert.ok(
    makeupKeys.every((k) => k >= left && k < TODAY),
    `可补格必须全在 [今天-6, 昨天] 内，实际 ${makeupKeys.join(',')}`,
  );

  const old = data<Calendar>(await getCal(LAST_MONTH));
  const lastDim = new Date(Number(LAST_MONTH.slice(0, 4)), Number(LAST_MONTH.slice(5, 7)), 0).getDate();
  assert.equal(old.days.length, lastDim + 12, '历史月同样带前后各 6 天补位');
  assert.equal(old.days.some((d) => d.state === 'makeup'), false, '历史月份不得出现可补格');
  assert.equal(byKey(old, OLD_MISSED)!.state, 'missed', '窗口外的漏签日是 missed：端上点了由补签接口回 400，判据不能错标');
});

test('CAL-3 month 参数闸门：非法格式 400 且点名收到的值', async () => {
  // '2026-13' 形状合规但月份不存在：JS 的 Date 会把它卷成次年 1 月，只校验正则等于放行
  for (const bad of ['2026-13', '2026-1', 'not-a-month']) {
    const res = await getCal(bad);
    assert.equal(res.statusCode, 400, `${bad} → ${res.body}`);
    assert.match(res.json().message, new RegExp(bad), '入参要回显，别只说「参数错误」');
  }
});

test('CAL-4 未登录 401', async () => {
  const res = await app.inject({ method: 'GET', url: `${API}/points/signin/calendar` });
  assert.equal(res.statusCode, 401, res.body);
});

test('CAL-5 补位日期带真实窗口状态：跨月的可补日照样标 makeup', async () => {
  // 直接调 service 钉住时钟：今天 11-02 → 补签窗口 [10-27, 11-01]，10-27 落在 11 月视图的首行补位里
  const NOW = Date.UTC(2026, 10, 2, 2, 0, 0);
  await PointSigninModel.deleteMany({ userId: uid });
  await PointSigninModel.create({
    userId: uid, dateKey: '2026-11-01', streakDay: 5, points: 5, source: 'sign', createdAt: NOW,
  });
  const c = await getSigninCalendar(userId, '2026-11', NOW);
  assert.equal(byKey(c, '2026-10-27')!.state, 'makeup', '窗口左缘的跨月漏签日必须标成可补');
  assert.equal(byKey(c, '2026-10-26')!.state, 'missed', '窗口外的补位日不可补');
  assert.equal(byKey(c, '2026-11-01')!.state, 'signed');
  assert.equal(byKey(c, '2026-11-01')!.streakDay, 5, '补位与跨月都不影响已签日取库存值');
});
