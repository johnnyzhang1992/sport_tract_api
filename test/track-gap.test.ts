/**
 * 采样断档连线标记（utils/track-gap.ts）单测。
 *
 * 要治的是「丢锁几秒后重定位横穿到别处」画出来的那条**不该存在的斜线**：地图上表现为一条
 * 直线切过内场/空地，看着像用户抄了近道。
 *
 * 三条判据缺一不可（都有实测依据）：
 * 1) 采样间隔被拉长（≥2× 中位间隔且 ≥5s）——只有"这段时间没点"才有资格谈不可信；
 * 2) 位移超过这段时间按自己的节奏所能走出的距离（×2.5 余量）——否则只是慢走/停下；
 * 3) **横向偏移**超过这段时间所能移动的距离（×1.5 余量）——这一条是后加的：
 *    线上样本 6ab8f4d7d5b8a92521664bc7（591 点）判出 5 步 66–112m / 6–10s，看着都是漂移，
 *    但实测它们与局部行进方向夹角只有 1–11°（横向偏移 1.3–12.6m），是**沿着跑道把弯切了**，
 *    线本来就贴着自己的轨迹。把它们断开，等于在正常的线上挖 5 个洞，用户原话"还不如原来"。
 *    真横穿（位置跳到侧向几十米外）才会同时越过第 3 条。
 *
 * 只打标：点不删、坐标与时间戳逐位不变、距离/配速等指标一律不受影响。
 * 运行：npm test；依赖：仅 node 内置模块。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  markGapJumps,
  detectGapSteps,
  GAP_MIN_SEC,
  GAP_SEC_MULT,
  GAP_DIST_MULT,
  GAP_MIN_M,
  GAP_CROSS_MULT,
  GAP_CROSS_MIN_M,
  GAP_HEADING_SEC,
} from '../src/utils/track-gap.js';

/**
 * 拼轨迹：每步 {m=沿行进方向(东)位移, sec=耗时, cross=横向(北)位移}
 * 与纠偏测试同一套夹具口径（等距圆柱，纬度 30.5°）
 */
function makeTrack(steps: Array<{ m: number; sec: number; cross?: number }>, startLat = 30.5) {
  const M_PER_DEG = ((2 * Math.PI * 6371000) / 360) * Math.cos((startLat * Math.PI) / 180);
  const pts: Array<{ lat: number; lng: number; timestamp: number; gapJump?: boolean }> = [
    { lat: startLat, lng: 114.4, timestamp: 0 },
  ];
  for (const s of steps) {
    const prev = pts[pts.length - 1];
    pts.push({
      lat: prev.lat + (s.cross ?? 0) / M_PER_DEG,
      lng: prev.lng + s.m / M_PER_DEG,
      timestamp: prev.timestamp + s.sec * 1000,
    });
  }
  return pts;
}
const NORMAL = { m: 4.8, sec: 2 }; // 2.4 m/s，与样本轨迹的中位步速一致
/** 位移 d、与行进方向夹角 deg° 的一步（拆成沿向 + 横向） */
const at = (d: number, sec: number, deg: number) => ({
  m: d * Math.cos((deg * Math.PI) / 180),
  cross: d * Math.sin((deg * Math.PI) / 180),
  sec,
});
/** 一步：沿 heading（0=正北，顺时针）走 d 米、耗时 sec 秒（夹具用 m=东、cross=北） */
const step = (d: number, heading: number, sec: number) => {
  const rad = (heading * Math.PI) / 180;
  return { m: d * Math.sin(rad), cross: d * Math.cos(rad), sec };
};
/** 等步长转弯：从 startHeading 起每步转 turnDeg，共 n 步 */
const turnSteps = (n: number, startHeading: number, turnDeg: number, d = 4.8, sec = 2) =>
  Array.from({ length: n }, (_, k) => step(d, startHeading + turnDeg * k, sec));

const flagged = (pts: Array<{ gapJump?: boolean }>) =>
  pts.map((p, i) => (p.gapJump ? i : -1)).filter((i) => i >= 0);

test('横穿漂移打标：间隔 7s、一步斜着蹦到侧向 72m 外 → 标记该步的落点', () => {
  const pts = makeTrack([...Array(8).fill(NORMAL), at(75, 7, 73), ...Array(8).fill(NORMAL)]);
  const { points, gaps } = markGapJumps(pts);
  assert.equal(gaps, 1, '应判出一处横穿');
  assert.deepEqual(flagged(points), [9], '标记落在蹦出去那一步的落点上');
  assert.equal(points.length, pts.length, '一个点都不能删');
});

test('沿跑道切角不标：75m/7s 全在同方向上（横向 0m）→ 线照画', () => {
  const pts = makeTrack([...Array(8).fill(NORMAL), { m: 75, sec: 7 }, ...Array(8).fill(NORMAL)]);
  assert.equal(markGapJumps(pts).gaps, 0, '同向蹦跳只是把弯切了，断开会在正常线上挖洞');
});

test('真实样本回归：那条 591 点跑步的 5 个实测长步（夹角 1–11°）一处都不该标', () => {
  // 线上活动 6ab8f4d7d5b8a92521664bc7（本地副本 6ab9066c91cf98e4d5f663a0）实测：
  // 75m/7s@1°、96m/8s@5°、66m/6s@6°、66m/6s@11°、112m/10s@3°，全部沿跑道
  const real = [at(75, 7, 1), at(96, 8, 5), at(66, 6, 6), at(66, 6, 11), at(112, 10, 3)];
  const pts = makeTrack([...Array(8).fill(NORMAL), real[0], ...Array(4).fill(NORMAL), real[1], ...Array(4).fill(NORMAL), real[2], ...Array(4).fill(NORMAL), real[3], ...Array(4).fill(NORMAL), real[4], ...Array(8).fill(NORMAL)]);
  assert.equal(markGapJumps(pts).gaps, 0, '这条轨迹断开后"看着还不如原来"，必须一处都不标');
});

test('起步第一步没有前方参照：判不了横向 → 保留连线', () => {
  const head = makeTrack([{ m: 0, cross: 100, sec: 6 }, ...Array(10).fill(NORMAL)]);
  assert.equal(markGapJumps(head).gaps, 0, '拿不准就不断线，别在正常的线上挖洞');
});

test('已知盲区：连着两次丢锁时第二次取不到参照 → 不判（宁可留线）', () => {
  // 两次横穿背靠背：第二次的"前方 6s 窗口"里只有第一次的落点，弦长虽够但方向本身就是漂出来的
  const pts = makeTrack([
    ...Array(8).fill(NORMAL),
    at(70, 7, 80),
    at(70, 7, 80),
    ...Array(8).fill(NORMAL),
  ]);
  assert.equal(markGapJumps(pts).gaps, 0, '两侧参照凑不齐时一律不判；这条盲区写进文档，别当已解决');
});

test('急转弯里顺着自己方向蹦一步：后方参照能证明没横穿，不该标', () => {
  // 每步转 20°（半径 ≈14m 的急弯，折返/绕障这个量级），第 8 步后航向 140°；
  // 中途一步沿**当时航向 160°** 蹦 90m/7s，出弯后照 160° 直行。
  // 断档前 6s 的合位移弦 ≈120°，与这一步差 40° → 只看前方弦会算出 58m 横向偏移而误判横穿；
  // 后方弦与这一步同向（横向 0）→ 取两条弦里更贴合的那条就不标。
  const pts = makeTrack([...turnSteps(8, 0, 20), step(90, 160, 7), ...Array(6).fill(step(4.8, 160, 2))]);
  assert.equal(markGapJumps(pts).gaps, 0, '这一步就是自己的前进方向，断开等于在正常线上挖洞');
});

test('同样急转弯，但位移指向航向右侧 90°（真横穿）→ 该标', () => {
  const pts = makeTrack([...turnSteps(8, 0, 20), step(90, 250, 7), ...Array(6).fill(step(4.8, 160, 2))]);
  assert.equal(markGapJumps(pts).gaps, 1, '真横穿对前后两条弦都近乎垂直');
});

test('斜得不狠不标：位移够长但横向偏移仍在"这段时间能走到的范围"内', () => {
  // 中位步速 2.4m/s、间隔 8s → 位移门槛 max(25, 2.4×8×2.5)=48m，横向门槛 max(20, 2.4×8×1.5)=28.8m
  // 这一步：位移 60m、夹角 20° → 横向 20.5m < 28.8m
  const pts = makeTrack([...Array(8).fill(NORMAL), at(60, 8, 20), ...Array(8).fill(NORMAL)]);
  const { points } = markGapJumps(pts);
  assert.equal(flagged(points).length, 0, '横向 20.5m 还在可解释范围内，不该断线');
});

test('不误伤：长间隔但位移合理（停下再走）不标记', () => {
  const pts = makeTrack([...Array(8).fill(NORMAL), { m: 20, sec: 60 }, ...Array(8).fill(NORMAL)]);
  assert.equal(markGapJumps(pts).gaps, 0, '60s 挪 20m 是停下，不是漂移');
});

test('不误伤：间隔没变长的真高速步（冲刺）不标记', () => {
  const pts = makeTrack([
    ...Array(6).fill(NORMAL),
    { m: 16, sec: 2 },
    { m: 16, sec: 2 },
    { m: 16, sec: 2 },
    ...Array(6).fill(NORMAL),
  ]);
  assert.equal(markGapJumps(pts).gaps, 0, '2s/16m 是冲刺速度，但采样没断档，不该标');
});

test('按全轨迹中位步速自适应：骑行 12m/s 中途一次横穿 5s/60m 不误标', () => {
  const cruise = { m: 24, sec: 2 };
  // 位移门槛 = 12×5×2.5 = 150m → 60m 的步先被第 2 条挡下
  const pts = makeTrack([...Array(8).fill(cruise), at(60, 5, 90), ...Array(8).fill(cruise)]);
  assert.equal(markGapJumps(pts).gaps, 0, '与该类型自身节奏一致的步长不算漂移');
});

test('骑行慢不下来：真横穿 5s/200m（侧向 200m）要标', () => {
  const cruise = { m: 24, sec: 2 };
  const pts = makeTrack([...Array(8).fill(cruise), at(200, 5, 90), ...Array(8).fill(cruise)]);
  assert.equal(markGapJumps(pts).gaps, 1, '门槛按该类型自己的中位步速走，快运动也能判');
});

test('间隔门槛取「2×中位间隔」与 5 秒的较大值：中位 2s 时 4s 的步不判', () => {
  const pts = makeTrack([...Array(8).fill(NORMAL), at(40, 4, 90), ...Array(8).fill(NORMAL)]);
  assert.equal(markGapJumps(pts).gaps, 0, '4s 既不到 5s 绝对下限，也不到 2×中位');
});

test('位移绝对下限 25m：慢速运动里"间隔长但没走出 25m"不判', () => {
  const pts = makeTrack([
    ...Array(8).fill({ m: 2.4, sec: 2 }),
    at(20, 8, 90),
    ...Array(8).fill({ m: 2.4, sec: 2 }),
  ]);
  assert.equal(markGapJumps(pts).gaps, 0);
});

test('幂等：已带 gapJump 的点先清再按本次结果重标（回填/重跑纠偏不会累积）', () => {
  const pts = makeTrack([...Array(8).fill(NORMAL), at(75, 7, 73), ...Array(8).fill(NORMAL)]);
  pts[3].gapJump = true; // 上一次跑出来的标记，且这次不该存在
  const { points } = markGapJumps(pts);
  assert.equal(points[3].gapJump, undefined, '旧标记必须被清掉');
  assert.deepEqual(flagged(points), [9]);
  assert.equal(markGapJumps(points).gaps, 1, '再跑一遍结果不变（幂等）');
});

test('无时间戳/时间戳乱序：不判也不崩，全部点原样返回', () => {
  const noTs = Array.from(
    { length: 10 },
    (_, i) => ({ lat: 30.5, lng: 114.4 + i * 0.001 } as { lat: number; lng: number; timestamp?: number; gapJump?: boolean }),
  );
  assert.equal(markGapJumps(noTs).gaps, 0);
  assert.equal(markGapJumps(noTs).points.length, 10);
  const back = makeTrack([...Array(8).fill(NORMAL)]);
  back[4].timestamp = back[3].timestamp - 1000; // 时钟回退
  assert.equal(markGapJumps(back).gaps, 0, '负间隔的步不参与判定');
});

test('点数不足或全同位置：返回空标记（中位数取不到时不瞎判）', () => {
  assert.equal(markGapJumps([]).gaps, 0);
  const flat = Array.from({ length: 6 }, (_, i) => ({ lat: 30.5, lng: 114.4, timestamp: i * 2000 }));
  assert.equal(markGapJumps(flat).gaps, 0, '一步都没走 → 中位步速 0，不该把所有步都判成漂移');
});

test('detectGapSteps：折算口径只看前两条判据，沿跑道的长步也要报', () => {
  // markGapJumps 带第三条横向闸门（视觉不断线），但距离虚高恰恰来自这类"沿跑道跳到前面"的步
  const pts = makeTrack([...Array(8).fill(NORMAL), { m: 75, sec: 7 }, ...Array(8).fill(NORMAL)]);
  assert.equal(markGapJumps(pts).gaps, 0, '同一份输入，视觉标记不标');
  const { steps, medSpeed } = detectGapSteps(pts);
  assert.equal(steps.length, 1, '但折算要看得到它');
  assert.equal(steps[0].index, 9);
  assert.ok(Math.abs(steps[0].distM - 75) < 1, `位移 ${steps[0].distM}`);
  assert.ok(Math.abs(medSpeed - 2.4) < 0.1, `中位步速 ${medSpeed}`);
  // 这 7s 人按自己节奏只能走 2.4×7 ≈ 16.8m，其余都是虚高
  assert.ok(Math.abs(steps[0].plausibleM - medSpeed * 7) < 0.01);
  assert.ok(steps[0].overM > 55 && steps[0].overM < 60, `虚高 ${steps[0].overM}`);
});

test('detectGapSteps：真实样本那 5 步全部报出，虚高合计约 328m', () => {
  // 线上样本实测（本地副本 6ab9066c）：5 处沿跑道的长步，视觉一处都不标
  const real = [at(75, 7, 1), at(96, 8, 5), at(66, 6, 6), at(66, 6, 11), at(112, 10, 3)];
  const pts = makeTrack([
    ...Array(8).fill(NORMAL),
    real[0],
    ...Array(4).fill(NORMAL),
    real[1],
    ...Array(4).fill(NORMAL),
    real[2],
    ...Array(4).fill(NORMAL),
    real[3],
    ...Array(4).fill(NORMAL),
    real[4],
    ...Array(8).fill(NORMAL),
  ]);
  const { steps, chordM, overM } = detectGapSteps(pts);
  assert.equal(markGapJumps(pts).gaps, 0);
  assert.equal(steps.length, 5);
  const chord = Math.round(chordM);
  assert.ok(chord > 400 && chord < 430, `弦合计 ${chord}m`);
  const over = Math.round(overM);
  assert.ok(over > 300 && over < 360, `虚高合计 ${over}m`);
});

test('detectGapSteps：点数不足或没走动时不判也不崩', () => {
  assert.equal(detectGapSteps([]).steps.length, 0);
  const flat = Array.from({ length: 6 }, (_, i) => ({ lat: 30.5, lng: 114.4, timestamp: i * 2000 }));
  assert.equal(detectGapSteps(flat).steps.length, 0, '中位步速 0 时不该把所有步都算成虚高');
});

test('常量口径外露（供文档与前端对齐）', () => {
  assert.equal(GAP_MIN_SEC, 5);
  assert.equal(GAP_SEC_MULT, 2);
  assert.equal(GAP_DIST_MULT, 2.5);
  assert.equal(GAP_MIN_M, 25);
  assert.equal(GAP_CROSS_MULT, 1.5);
  assert.equal(GAP_CROSS_MIN_M, 20);
  assert.equal(GAP_HEADING_SEC, 6);
});
