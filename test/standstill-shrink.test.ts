import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shrinkStillSegments, STILL_SHRINK_KEEP_EVERY } from '../src/utils/standstill.js';

/** 造连续 still 段 */
function stillRun(n: number, tag: string) {
  return Array.from({ length: n }, (_, i) => ({ still: true as const, lat: i, tag }));
}
function movePoint(tag: string) {
  return { still: false as const, lat: -1, tag };
}

test('收缩：长 still 段保留首/尾/抽样点，大幅减少点数', () => {
  const pts = [movePoint('in'), ...stillRun(70, 'seg'), movePoint('out')];
  const out = shrinkStillSegments(pts);
  const kept = out.filter((p) => p.still);
  // 70 点 → 首 + 抽样(每30) + 尾 ≈ 4 个
  assert.ok(kept.length >= 3 && kept.length <= 6, `长段应收缩到 3~6 点，实际 ${kept.length}`);
  assert.equal(kept[0].tag, 'seg', '段首必留');
  assert.equal(kept[kept.length - 1].tag, 'seg', '段尾必留（离开静止的位置）');
  assert.equal(kept[kept.length - 1].tag, 'seg', '段尾必留（离开静止的位置）');
  // 顺序保持
  const lats = kept.map((p) => p.lat);
  assert.deepEqual(lats, [...lats].sort((a, b) => a - b), '保留点应保持原顺序');
});

test('收缩：非 still 点全部保留', () => {
  const pts = [movePoint('a'), ...stillRun(65, 's'), movePoint('b'), movePoint('c')];
  const out = shrinkStillSegments(pts);
  assert.ok(out.some((p) => p.tag === 'a'));
  assert.ok(out.some((p) => p.tag === 'b'));
  assert.ok(out.some((p) => p.tag === 'c'));
});

test('收缩：短段（< keepEvery）全保留不动', () => {
  const pts = [movePoint('in'), ...stillRun(10, 'short'), movePoint('out')];
  const out = shrinkStillSegments(pts);
  assert.equal(out.filter((p) => p.still).length, 10, '10 点段在 keepEvery=30 下应全保留');
});

test('收缩：段尾即轨迹末尾时尾点保留', () => {
  const pts = [movePoint('in'), ...stillRun(50, 'tail')];
  const out = shrinkStillSegments(pts);
  const kept = out.filter((p) => p.still);
  assert.equal(kept[kept.length - 1].tag, 'tail', '末尾 still 点应保留');
});

test('收缩：keepEvery 可调（更密的抽样）', () => {
  const pts = [movePoint('in'), ...stillRun(70, 'seg'), movePoint('out')];
  const out = shrinkStillSegments(pts, 10);
  const kept = out.filter((p) => p.still).length;
  assert.ok(kept >= 7 && kept <= 9, `keepEvery=10 时 70 点段应保留 7~9 点，实际 ${kept}`);
});

test('常量：默认抽样间隔为 30', () => {
  assert.equal(STILL_SHRINK_KEEP_EVERY, 30);
});
