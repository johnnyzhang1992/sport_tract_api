/**
 * 徽章配置化（2026-11-16）：配置自身的一致性与「改配置即可」的保证。
 * 运行：node --import tsx --test test/badge-config.test.ts
 *
 * 这些测试守的是**配置化的承诺**：
 *   1. 每座徽章都有完整展示元数据（前端不需要再维护映射表）
 *   2. key 唯一、系列不重叠、分组都存在标题
 *   3. 加档位 = 自动多一座徽章（BADGE_DEFS 由 tiers 展开，不用手写）
 *   4. 解锁日期算法对每座徽章都能给出结果（不会出现「已解锁但没有日期」）
 *   5. 排名侧与 summary 侧用的是同一份定义（不会两处不同步）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVITY_BADGE_META,
  ACTIVITY_BADGE_TYPES,
  ACTIVITY_TIER_PRESETS,
  BADGE_DEFS,
  BADGE_GROUPS,
  BADGE_SERIES,
  BADGE_TIERS,
  MILESTONES,
  RATIO_TIERS,
  allBadgeKeys,
  groupTitleOf,
  reachedTier,
  seriesOfBadge,
} from '../src/config/badge-config.js';
import { computeBadgeEarns, minRatioOf, tierOf } from '../src/services/badge-earn.js';

test('BC1 key 全局唯一（含里程碑，含完美周显式 key）', () => {
  const keys = allBadgeKeys();
  const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
  assert.deepEqual(dup, [], `重复 key: ${dup.join(',')}`);
});

test('BC2 每座徽章都有前端需要的全部展示字段', () => {
  for (const d of BADGE_DEFS) {
    assert.ok(d.key, 'key');
    assert.ok(d.label, `${d.key} 缺 label`);
    assert.ok(d.shortLabel, `${d.key} 缺 shortLabel`);
    assert.ok(d.desc, `${d.key} 缺 desc`);
    assert.ok(d.shape, `${d.key} 缺 shape`);
    assert.ok(d.icon, `${d.key} 缺 icon`);
    assert.ok(d.centerText, `${d.key} 缺徽章中央文字`);
    assert.ok(d.tier > 0, `${d.key} tier 必须为正`);
  }
});

test('BC3 分组顺序与标题齐全：每个 group 都能拿到标题', () => {
  const known = new Set(BADGE_GROUPS.map((g) => g.key));
  for (const d of BADGE_DEFS) assert.ok(known.has(d.group), `${d.key} 的分组 ${d.group} 没有标题`);
  for (const g of BADGE_GROUPS) assert.ok(groupTitleOf(g.key), `${g.key} 标题为空`);
});

test('BC4 数量 = 各系列档位之和 + 里程碑数（改 tiers 自动生效）', () => {
  // 普通系列：档位数；分类型系列：每个类型按自己的档位预设各展开一套
  const expected = BADGE_SERIES.reduce((acc, s) => {
    if (s.types && s.types.length) {
      return acc + s.types.reduce((n, type) => {
        const preset = s.metricByType === 'typeDistanceKm'
          ? ACTIVITY_TIER_PRESETS.distance[type as keyof typeof ACTIVITY_TIER_PRESETS.distance]
          : s.tiers;
        return n + (preset ? preset.length : s.tiers.length);
      }, 0);
    }
    return acc + s.tiers.length;
  }, 0) + MILESTONES.length;
  assert.equal(BADGE_DEFS.length + MILESTONES.length, expected);
  // 当前配置（2026-11-16）：
  //   新纪录 2×4 + 最坚持 4 + 合环 4（三类都去掉 2000）+ 累计里程 6 + 累计时长 6 + 完美周 4 = 32
  //   分运动类型 5 类型 × (距离 6 + 时长 4 + 次数 6 = 16) = 80
  //   → 系列共 112；+ 7 座里程碑 = 119
  assert.equal(BADGE_DEFS.length, 112, '系列展开数应为 112');
  assert.equal(MILESTONES.length, 7, '里程碑应为 7 座');
  assert.equal(expected, 119, '总计应为 119 座');
});

test('BC5 每座徽章都能找到所属系列（含完美周显式 key）', () => {
  for (const d of BADGE_DEFS) {
    const s = seriesOfBadge(d);
    assert.ok(s, `${d.key} 找不到系列`);
    // 档位合法性：普通系列看 s.tiers，分类型系列看该类型的预设（各类型档位可不同）
    if (s.types && d.activityType) {
      assert.ok(d.key.startsWith(`${ACTIVITY_BADGE_META[d.activityType].prefix}-`), `${d.key} 前缀与类型不符`);
    } else {
      assert.ok(s.tiers.includes(d.tier), `${d.key} 的档位不在系列阶梯里`);
    }
    assert.equal(s.group, d.group, `${d.key} 分组与系列不一致`);
  }
});

test('BC6 完美周 key 与历史线上 key 一致（不能改名，否则老用户徽章丢失）', () => {
  const weekKeys = BADGE_DEFS.filter((d) => d.group === 'week').map((d) => d.key).sort();
  assert.deepEqual(weekKeys, [
    'perfect-week-all',
    'perfect-week-count',
    'perfect-week-distance',
    'perfect-week-duration',
  ]);
});

test('BC7 可重复获得的系列：完美周带 repeatable 与固定中央文字', () => {
  for (const d of BADGE_DEFS) {
    if (d.group !== 'week') continue;
    assert.equal(d.repeatable, true, `${d.key} 应可重复获得`);
    assert.notEqual(d.centerText, String(d.tier), `${d.key} 中央文字不该是档位数字`);
  }
});

test('BC8 reachedTier：档位映射单调、0 档返回 0', () => {
  const t = BADGE_TIERS.count;
  assert.equal(reachedTier(t, 0), 0);
  assert.equal(reachedTier(t, 99), 0);
  assert.equal(reachedTier(t, 100), 100);
  assert.equal(reachedTier(t, 364), 100);
  assert.equal(reachedTier(t, 365), 365);
  assert.equal(reachedTier(t, 99999), 1000, 'count 最高档 1000（2000 已去掉）');
});

test('BC9 空数据下不给任何徽章解锁（不会凭空产生获得日期）', () => {
  const earns = computeBadgeEarns({ days: [], typeDays: {}, dailyRows: [], periodRows: [] });
  assert.deepEqual(earns, {});
});

test('BC10 每座徽章都能被算法覆盖：造满数据后全部可解锁且有日期', () => {
  // 造 500 天连续运动，每天距离/时长递增；外加 2100 个三项全达成日快照（覆盖最高档 2000）
  const days = [];
  const dailyRows = [];
  for (let i = 0; i < 2100; i += 1) {
    const date = new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
    // 距离/时长逐日递增 → 每天都破纪录（nthBreak 系列才够解锁）；
    // 每日 6km/2h，2100 天累计约 12600km、4200h，覆盖最高档（10000km / 1000h）
    days.push({ date, distanceM: 6000 + i, durationSec: 7200 + i, count: 5 });
    dailyRows.push({
      period: 'daily',
      periodKey: date,
      windowEnd: Date.parse(`${date}T00:00:00+08:00`) + 86_400_000,
      allAchieved: true,
      targets: { distanceM: 1000, durationMin: 30, count: 1 },
      progress: { distanceM: 5000, durationSec: 3600, count: 3 },
    });
  }
  // 分运动类型徽章需要 typeDays：给每个主力类型各造一份（累计距离/时长/次数都超最高档）
  const typeDays: Record<string, typeof days> = {};
  for (const type of ACTIVITY_BADGE_TYPES) {
    typeDays[type] = days.slice(0, 300).map((d, i) => ({
      date: d.date,
      distanceM: 70_000, // 300 天 × 70km ≈ 21000km，覆盖最高 10000km 档
      durationSec: 36_000, // 累计 3000 小时，覆盖最高 500h 档
      count: 5, // 累计 1500 次，覆盖最高 1000 次档
    }));
  }
  const earns = computeBadgeEarns({ days, dailyRows, periodRows: dailyRows, typeDays });

  for (const d of BADGE_DEFS) {
    const e = earns[d.key];
    assert.ok(e, `徽章 ${d.key}（${d.earnKind}）在满数据下仍未解锁——算法没覆盖到它`);
    assert.ok(e.earnDate, `徽章 ${d.key} 已解锁但缺解锁日期（名次会算不出来）`);
  }
});

test('BC11 里程碑与倍率口径：tierOf 取最高档不重复计数', () => {
  assert.equal(tierOf(0.5), 0);
  assert.equal(tierOf(1), 1);
  assert.equal(tierOf(2.9), 2);
  assert.equal(tierOf(5.5), 5);
  assert.deepEqual([...RATIO_TIERS], [1, 2, 3, 4, 5]);
});

test('BC12 minRatioOf：目标为 0 的项不参与（未设项不算拖后腿）', () => {
  assert.equal(
    minRatioOf({ distanceM: 2000, durationSec: 3600, count: 5 }, { distanceM: 1000, durationMin: 0, count: 0 }),
    2,
    '只设了距离目标时，倍数按距离算',
  );
  assert.equal(
    minRatioOf({ distanceM: 500, durationSec: 3600, count: 1 }, { distanceM: 1000, durationMin: 30, count: 1 }),
    0.5,
    '三项都设时取最弱一项',
  );
  assert.equal(minRatioOf({ distanceM: 1, durationSec: 1, count: 1 }, { distanceM: 0, durationMin: 0, count: 0 }), 0);
});
test('BC13 次数类三类（新纪录/最坚持/合环）都去掉 2000 档，统一为 4 档', () => {
  for (const group of ['record', 'streak', 'rings']) {
    const tiers = BADGE_DEFS.filter((d) => d.group === group).map((d) => d.tier).sort((a, b) => a - b);
    assert.deepEqual([...new Set(tiers)], [100, 365, 500, 1000], `${group} 应为 100/365/500/1000`);
  }
  for (const key of ['rec-dist-2000', 'rec-dur-2000', 'streak-2000', 'ring-2000']) {
    assert.equal(BADGE_DEFS.find((d) => d.key === key), undefined, `${key} 不应再出现`);
  }
  // 累计类仍然保留 2000/5000/10000（没有「每天一次」的约束）
  assert.deepEqual(BADGE_TIERS.totalKm, [100, 500, 1000, 2000, 5000, 10000]);
  assert.ok(BADGE_DEFS.find((d) => d.key === 'total-dist-2000'), '累计里程 2000 档应保留');
});

test('BC14 档位加档（2026-11-16）：累计里程加 10000、累计时长加 1000，100 档保留', () => {
  const tiers = (group: string) => BADGE_DEFS.filter((d) => d.group === group).map((d) => d.tier);
  assert.deepEqual(tiers('total-distance'), [100, 500, 1000, 2000, 5000, 10000], '累计里程应含 100 与新增 10000');
  assert.deepEqual(tiers('total-duration'), [10, 50, 100, 200, 500, 1000], '累计时长应含 100 与新增 1000');
});

test('BC15 分运动类型档位：距离去掉 50 保留 100 并加 1000/2000/5000/10000；时长去掉 50 保留 100 加 200/500；次数加 200/500/1000', () => {
  const typed = BADGE_DEFS.filter((d) => d.activityType);
  const tiersOf = (metric: string) => typed.filter((d) => d.metric === metric).map((d) => d.tier);
  // 距离：五种类型都是 100 起步的 6 档
  for (const t of ACTIVITY_BADGE_TYPES) {
    const dist = typed.filter((d) => d.activityType === t && d.metric === 'typeDistanceKm').map((d) => d.tier);
    assert.deepEqual(dist, [100, 500, 1000, 2000, 5000, 10000], `${t} 距离档位不对`);
  }
  assert.ok(!tiersOf('typeDistanceKm').includes(50), '距离 50 档应已去掉');
  // 时长：10/100/200/500（50 去掉、100 保留）
  assert.deepEqual([...new Set(tiersOf('typeDurationHour'))], [10, 100, 200, 500]);
  // 次数：10/50/100/200/500/1000
  assert.deepEqual([...new Set(tiersOf('typeCount'))], [10, 50, 100, 200, 500, 1000]);
});

test('BC16 分类型徽章总数：5 类型 × (距离 6 + 时长 4 + 次数 6) = 80', () => {
  const typed = BADGE_DEFS.filter((d) => d.activityType);
  assert.equal(typed.length, 80);
  for (const t of ACTIVITY_BADGE_TYPES) {
    assert.equal(typed.filter((d) => d.activityType === t).length, 16, `${t} 应有 16 座`);
  }
});
