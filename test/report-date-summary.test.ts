import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Types } from 'mongoose';
import { buildApp } from '../src/app.js';
import { ActivityModel } from '../src/models/activity.model.js';
import { buildDateSummary } from '../src/services/report.js';

/**
 * 报告页「日期汇总」后端分桶测试：
 * - 月：自然周（周一为界），跨月不裁（首尾周含相邻月份天数），无 1~2 天短周
 * - 周：按天，7 天完整时间线
 * - 年：按月，12 个月完整时间线
 * - 回归：轨迹带时分秒也要正确入桶（旧前端实现按 Monday.getTime() 比较时全落空）
 */

let app: Awaited<ReturnType<typeof buildApp>>;
const userId = new Types.ObjectId();

/** 东八区时间 → epoch ms（h 可越界，自动归一） */
const bj = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h - 8, mi);

async function seed(rows: Array<{ at: number; distance: number; duration?: number; calories?: number }>) {
  await ActivityModel.insertMany(
    rows.map((r) => ({
      userId,
      type: 'running',
      status: 'finished',
      startTime: r.at,
      distance: r.distance,
      duration: r.duration ?? 600,
      calories: r.calories ?? 100,
    })),
  );
}

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

after(async () => {
  await ActivityModel.deleteMany({ userId }).catch(() => {});
  await app.close();
  const mongoose = (await import('mongoose')).default;
  await mongoose.disconnect().catch(() => {});
});

test('月视图：自然周周一为界，跨月不裁，无 1~2 天短周', async () => {
  await ActivityModel.deleteMany({ userId });
  // 2024-08：8/1 周四 → 首周从 7/29 周一起；8/31 周六 → 末周延伸到 9/1
  await seed([
    { at: bj(2024, 7, 30, 8, 0), distance: 500 }, // 上个月，属首周 → 计入（A 口径）
    { at: bj(2024, 8, 1, 7, 30), distance: 1000 }, // 周四 07:30，属首周
    { at: bj(2024, 8, 5, 18, 5), distance: 2000 }, // 第二周
    { at: bj(2024, 8, 20, 9, 15), distance: 3000 }, // 第四周
    { at: bj(2024, 9, 1, 10, 0), distance: 4000 }, // 下个月，属末周 → 计入（A 口径）
  ]);

  const from = bj(2024, 8, 1);
  const to = bj(2024, 9, 1);
  const ds = await buildDateSummary(String(userId), 'month', { from, to });

  assert.equal(ds.title, '按周');
  assert.equal(ds.label, '周');
  assert.equal(ds.rows.length, 5, `应 5 个自然周，实际 ${ds.rows.length}`);
  assert.deepEqual(
    ds.rows.map((r) => r.label),
    ['0729-0804周', '0805-0811周', '0812-0818周', '0819-0825周', '0826-0901周'],
  );
  // 每一行都必须是完整 7 天：无 1~2 天短周
  for (const r of ds.rows) {
    const m = /^(\d{2})(\d{2})-(\d{2})(\d{2})周$/.exec(r.label);
    assert.ok(m, `标签格式异常: ${r.label}`);
  }
  // 首周含 7/30 + 8/1，末周含 9/1
  assert.equal(ds.rows[0].count, 2);
  assert.equal(ds.rows[0].distance, 1500);
  assert.equal(ds.rows[4].count, 1);
  assert.equal(ds.rows[4].distance, 4000);
  // 全部轨迹都要有归属，不能丢
  const total = ds.rows.reduce((s, r) => s + r.count, 0);
  assert.equal(total, 5, '5 条轨迹应全部入桶（回归：时分秒错桶会丢失）');
});

test('周视图：按天 7 桶，当前周不生成未来日期', async () => {
  await ActivityModel.deleteMany({ userId });
  await seed([
    { at: bj(2024, 8, 6, 9, 0), distance: 1111 },
    { at: bj(2024, 8, 6, 21, 30), distance: 2222 },
    { at: bj(2024, 8, 11, 0, 0), distance: 3333 }, // 周日 0 点边界
  ]);
  const ds = await buildDateSummary(String(userId), 'week', {
    from: bj(2024, 8, 5),
    to: bj(2024, 8, 12),
  });
  assert.equal(ds.rows.length, 7);
  assert.equal(ds.rows[0].label, '8/5');
  assert.equal(ds.rows[6].label, '8/11');
  const wed = ds.rows.find((r) => r.label === '8/6');
  assert.equal(wed?.count, 2);
  assert.equal(wed?.distance, 3333);
  assert.equal(ds.rows[6].count, 1, '周日 0 点应归入当天');
});

test('年视图：按月 12 桶，跨月边界正确', async () => {
  await ActivityModel.deleteMany({ userId });
  await seed([
    { at: bj(2024, 1, 1, 7, 0), distance: 100 }, // 1/1 早 7 点
    { at: bj(2024, 1, 31, 23, 59), distance: 200 },
    { at: bj(2024, 12, 31, 23, 59), distance: 300 },
    { at: bj(2024, 7, 1, 0, 0), distance: 400 },
  ]);
  const ds = await buildDateSummary(String(userId), 'year', {
    from: bj(2024, 1, 1),
    to: bj(2025, 1, 1),
  });
  assert.equal(ds.rows.length, 12);
  assert.equal(ds.rows[0].label, '1月');
  assert.equal(ds.rows[0].count, 2);
  assert.equal(ds.rows[0].distance, 300);
  assert.equal(ds.rows[6].label, '7月');
  assert.equal(ds.rows[6].count, 1);
  assert.equal(ds.rows[11].label, '12月');
  assert.equal(ds.rows[11].count, 1);
  assert.equal(ds.rows.reduce((s, r) => s + r.count, 0), 4);
});

test('全部视图：按半年分桶', async () => {
  await ActivityModel.deleteMany({ userId });
  await seed([
    { at: bj(2023, 3, 1, 7, 0), distance: 100 },
    { at: bj(2023, 8, 1, 7, 0), distance: 200 },
    { at: bj(2024, 2, 1, 7, 0), distance: 300 }, // 2023H1 与 2024H1 之间的半年应为 0
  ]);
  const ds = await buildDateSummary(String(userId), 'all');
  assert.equal(ds.title, '按半年');
  const labels = ds.rows.map((r) => r.label);
  assert.equal(labels[0], '2023 上半年');
  assert.equal(labels[labels.length - 1], new Date(Date.now() + 8 * 3600000).getUTCFullYear() + (new Date(Date.now() + 8 * 3600000).getUTCMonth() < 6 ? ' 上半年' : ' 下半年'));
  assert.ok(labels.includes('2023 下半年'));
  assert.equal(ds.rows.find((r) => r.label === '2023 上半年')?.count, 1);
  assert.equal(ds.rows.find((r) => r.label === '2023 下半年')?.count, 1);
  assert.equal(ds.rows.find((r) => r.label === '2024 上半年')?.count, 1);
});

test('GET /overview?dateSummary=1：路由透传日期汇总（集成）', async () => {
  const login = await app.inject({
    method: 'POST',
    url: '/sport-track/api/auth/login',
    payload: { code: 'mock_report_date_summary' },
  });
  const body = login.json().data;
  const token = body.accessToken as string;
  const uid = body.user.id as string;
  assert.ok(token && uid);

  await ActivityModel.deleteMany({ userId: new Types.ObjectId(uid) });
  await ActivityModel.insertMany([
    {
      userId: new Types.ObjectId(uid),
      type: 'running',
      status: 'finished',
      startTime: bj(2024, 8, 6, 9, 0),
      distance: 1234,
      duration: 600,
      calories: 100,
    },
  ]);

  const res = await app.inject({
    method: 'GET',
    url: `/sport-track/api/overview?range=month&from=${bj(2024, 8, 1)}&to=${bj(2024, 9, 1)}&lean=1&dateSummary=1`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  const data = res.json().data;
  assert.ok(data.dateSummary, '应返回 dateSummary');
  assert.equal(data.dateSummary.title, '按周');
  assert.equal(data.dateSummary.rows.length, 5);
  const week = data.dateSummary.rows.find((r: { label: string }) => r.label === '0805-0811周');
  assert.ok(week, '应有 0805-0811周 桶');
  assert.equal(week.count, 1);
  assert.equal(week.distance, 1234);
  assert.equal(data.tracks[0].points, undefined, 'lean 模式不应下发轨迹点');

  await ActivityModel.deleteMany({ userId: new Types.ObjectId(uid) });
});
