import { PassThrough, Readable } from 'node:stream';
import { ZipArchive, type Archiver } from 'archiver';
import axios from 'axios';
import { Types } from 'mongoose';
import { AppError } from '../utils/app-error.js';
import { ACTIVITY_TYPES, ACTIVITY_TYPE_META } from '../config/constants.js';
import { BJ_OFFSET_MS } from '../utils/bj-time.js';
import { footprintCategoryLabel } from '../utils/footprint-category.js';
import { toGpx } from './gpx.js';
import { ActivityModel } from '../models/activity.model.js';
import { FootprintRecordModel } from '../models/footprint-record.model.js';
import { UserModel } from '../models/user.model.js';
import { getSignedUrl } from './oss.js';

/**
 * 运动数据导出（2026-11-01）：
 * - 汇总 CSV：昵称/类型/起止时间/三类时长/距离/点数，不含坐标明细与照片；
 *   流式逐批生成（PassThrough），CSV 用 UTF-8 BOM + CRLF 保证 Excel 双击打开中文不乱码。
 * - 批量 GPX zip：复用单条导出同一份 toGpx()（GCJ-02 → WGS-84 反算），archiver 流式打包，
 *   不落临时文件；单条上限兜住内存（每条至多 MAX_TRACK_POINTS 点）。
 * 时长口径沿用模型注释：运动时长 = 墙钟 − pausedMs(手动暂停) − standstillMs(静止) − vehicleMs(乘车)，
 * CSV 里三类暂停各占一列，不混算。
 */

/** 用户端 CSV 单次导出行数上限（超出提示缩小范围） */
export const EXPORT_CSV_MAX_ROWS = 5000;
/** 管理端 CSV 上限（跨用户量级更大） */
export const EXPORT_CSV_MAX_ROWS_ADMIN = 20_000;
/** 批量 GPX 单包条数上限：100 条 × 2 万点最坏 200 万点，archiver 流式可扛 */
export const EXPORT_GPX_MAX_ITEMS = 100;

/** CSV/GPX 批处理批大小：CSV 走 aggregate 分批查（投影后行很小），GPX 逐小批取全文档防内存峰值 */
const CSV_BATCH = 200;
const ZIP_BATCH = 20;

/** 导出频控：每 key（端点:用户）窗口内限 N 次；内存 Map 够用（个人工具量级，不上 Redis） */
export const EXPORT_RATE_WINDOW_MS = 60_000;
export const EXPORT_RATE_LIMIT = 5;
const rateMap = new Map<string, number[]>();

export function assertExportRate(key: string): void {
  // 测试环境豁免（与 activity.routes 的 CREATE_LIMIT 同一开关约定），resetExportRate 仅兜底特殊用例
  if (process.env.WX_MOCK_LOGIN === 'true' && process.env.NODE_ENV !== 'production') return;
  const now = Date.now();
  if (rateMap.size > 10_000) rateMap.clear(); // 粗暴防漏：只存时间窗内命中，泄漏上限有界
  const hits = (rateMap.get(key) ?? []).filter((t) => now - t < EXPORT_RATE_WINDOW_MS);
  if (hits.length >= EXPORT_RATE_LIMIT) throw new AppError(429, '导出太频繁，请稍后再试');
  hits.push(now);
  rateMap.set(key, hits);
}

/** 测试专用：清空频控窗口（node --test 每个文件独立进程，不跨文件泄漏） */
export function resetExportRate(): void {
  rateMap.clear();
}

/** 东八区 'YYYY-MM-DD HH:mm:ss'（库内 ms 时间戳；null/空 → 空串，in_progress 无结束时间照实留白） */
export function bjDateTime(ms: number | null | undefined): string {
  if (ms == null) return '';
  const d = new Date(ms + BJ_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** 文件名时间戳 'YYYYMMDD-HHmmss'（东八区） */
export function exportStamp(now: number = Date.now()): string {
  const s = bjDateTime(now); // 'YYYY-MM-DD HH:mm:ss'
  return `${s.slice(0, 10).replace(/-/g, '')}-${s.slice(11, 19).replace(/:/g, '')}`;
}

/** 秒 → 'HH:mm:ss'（小时可超 24，跨天长活动照实展示） */
export function hms(seconds: number): string {
  const s = Math.max(0, Math.round(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** CSV 转义：含 逗号/引号/换行 的字段包引号，内部引号翻倍 */
export function csvEscape(v: unknown): string {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 类型中文标签（ACTIVITY_TYPE_META 权威口径；未知类型兜底原值，别丢行） */
export function typeLabel(type: string): string {
  return ACTIVITY_TYPE_META[type as keyof typeof ACTIVITY_TYPE_META]?.label ?? type;
}

/** Content-Disposition：ASCII 兜底 + filename* 中文（wx.request 不看它，浏览器/管理端下载要） */
export function contentDisposition(ascii: string, utf8: string): string {
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(utf8)}`;
}

const CSV_HEADER = '轨迹ID,昵称,运动类型,开始时间,结束时间,运动时长,手动暂停,静止暂停,乘车时长,运动距离(公里),坐标点数量';

type SummaryOpts = {
  /** 用户端传本人 id；管理端按参数（可缺省 = 全部用户） */
  userId?: string;
  type?: string;
  status?: string; // 缺省 finished；管理端 status=all 传 undefined
  from?: number;
  to?: number;
  cap: number;
};

function buildSummaryFilter(opts: SummaryOpts): Record<string, unknown> {
  if (opts.type && !(ACTIVITY_TYPES as readonly string[]).includes(opts.type)) {
    throw new AppError(400, '无效的运动类型');
  }
  if (opts.userId && !Types.ObjectId.isValid(opts.userId)) throw new AppError(400, '无效的用户 ID');
  const filter: Record<string, unknown> = {};
  if (opts.status) filter.status = opts.status; // 用户端显式传 finished；管理端 status=all 传 undefined 不筛
  if (opts.userId) filter.userId = new Types.ObjectId(opts.userId);
  if (opts.type) filter.type = opts.type;
  const range: Record<string, unknown> = {};
  if (opts.from) range.$gte = opts.from;
  if (opts.to) range.$lte = opts.to;
  if (opts.from && opts.to && opts.to <= opts.from) throw new AppError(400, '时间范围无效');
  if (Object.keys(range).length) filter.startTime = range;
  return filter;
}

/**
 * 汇总 CSV 流。投影里 $size 数坐标点数，不把 trackPoints 全数组拖进内存；
 * 昵称按批 $in 查并缓存（管理端跨用户逐行昵称；用户端一行缓存即命中）。
 */
export async function exportSummaryCsv(opts: SummaryOpts): Promise<Readable> {
  const filter = buildSummaryFilter(opts);
  const total = await ActivityModel.countDocuments(filter);
  if (total === 0) throw new AppError(404, '没有符合条件的运动记录');
  if (total > opts.cap) {
    throw new AppError(400, `共 ${total} 条，超出单次导出上限 ${opts.cap} 条，请缩小时间范围或按类型筛选`);
  }

  const pass = new PassThrough();
  const pump = async () => {
    pass.write(`\uFEFF${CSV_HEADER}\r\n`);
    const nickCache = new Map<string, string>();
    for (let skip = 0; skip < total; skip += CSV_BATCH) {
      const rows = await ActivityModel.aggregate([
        { $match: filter },
        { $sort: { startTime: -1, _id: 1 } },
        {
          $project: {
            _id: 1,
            userId: 1, type: 1, startTime: 1, endTime: 1, duration: 1,
            pausedMs: 1, standstillMs: 1, vehicleMs: 1, distance: 1,
            pointCount: { $size: { $ifNull: ['$trackPoints', []] } },
          },
        },
        { $skip: skip },
        { $limit: CSV_BATCH },
      ]);
      // 本批昵称一次查齐（旧数据 user 可能已删：fallback '已注销'）
      const missing = [...new Set(rows.map((r) => String(r.userId)))].filter((id) => !nickCache.has(id));
      if (missing.length) {
        const users = await UserModel.find({ _id: { $in: missing.map((id) => new Types.ObjectId(id)) } })
          .select('nickname')
          .lean();
        for (const u of users) nickCache.set(String(u._id), u.nickname || '');
        for (const id of missing) if (!nickCache.has(id)) nickCache.set(id, '已注销');
      }
      for (const r of rows) {
        const line = [
          String(r._id),
          nickCache.get(String(r.userId)) ?? '',
          typeLabel(r.type),
          bjDateTime(r.startTime),
          bjDateTime(r.endTime),
          hms(r.duration),
          hms((r.pausedMs ?? 0) / 1000),
          hms((r.standstillMs ?? 0) / 1000),
          hms((r.vehicleMs ?? 0) / 1000),
          ((r.distance ?? 0) / 1000).toFixed(2),
          r.pointCount ?? 0,
        ]
          .map(csvEscape)
          .join(',');
        if (!pass.write(`${line}\r\n`)) await new Promise<void>((resolve) => pass.once('drain', resolve));
      }
    }
    pass.end();
  };
  void pump().catch((e) => pass.destroy(e));
  return pass;
}

function readmeBody(count: number): string {
  return [
    '小迹一下 · 轨迹明细导出',
    `导出时间：${bjDateTime(Date.now())}（东八区）`,
    `轨迹条数：${count}`,
    '',
    '坐标系：WGS-84 —— 与 Strava / 两步路 / Google Earth 等通用工具兼容。',
    '注意：微信/高德地图使用 GCJ-02 坐标，把 GPX 直接加载到高德底图上位置会偏移数百米，属正常现象。',
    '',
    '文件命名：开始日期_运动类型_轨迹ID（与运动记录 CSV 的「轨迹ID」列一致，可据此关联两份导出）',
    '内容：轨迹点（经纬度 / 海拔 / 时间）；轨迹打点以航点（wpt）保留名称与地址文本。',
    '不含：运动照片。',
    '',
  ].join('\n');
}

/**
 * 批量 GPX zip 流。查询阶段就限制「本人 + finished + 有点」，越权 id 静默落空（不报哪条不是你的）；
 * 计数前置校验后才开始出流——流已开始后再出错只能断连，不能换 JSON 错误响应。
 */
export async function exportGpxZip(opts: {
  userId: string;
  ids?: string[];
  from?: number;
  to?: number;
  type?: string;
  cap?: number;
}): Promise<{ archive: Archiver; done: Promise<void>; count: number }> {
  const cap = opts.cap ?? EXPORT_GPX_MAX_ITEMS;
  if (opts.type && !(ACTIVITY_TYPES as readonly string[]).includes(opts.type)) {
    throw new AppError(400, '无效的运动类型');
  }
  const filter: Record<string, unknown> = {
    status: 'finished',
    userId: Types.ObjectId.isValid(opts.userId) ? new Types.ObjectId(opts.userId) : opts.userId,
    'trackPoints.0': { $exists: true },
  };
  if (opts.type) filter.type = opts.type;
  if (opts.ids) {
    const ids = [...new Set(opts.ids.map((s) => s.trim()).filter(Boolean))];
    if (ids.some((id) => !Types.ObjectId.isValid(id))) throw new AppError(400, '轨迹 ID 无效');
    if (ids.length > cap) throw new AppError(400, `一次最多导出 ${cap} 条轨迹`);
    if (!ids.length) throw new AppError(400, '请先选择要导出的轨迹');
    filter._id = { $in: ids.map((id) => new Types.ObjectId(id)) };
  } else {
    // 「全部记录 + 全部类型」是合法选择（2026-11-05）：导出页的时间档默认就有「全部」，
    // 之前这里硬性要求 from/to/type 之一，用户选「全部/全部」必然 400。
    // 安全性由下面的**单次上限**兜住：超限给出可执行建议，而不是拦下「全部」这个档位。
    if (opts.from || opts.to) {
      const range: Record<string, unknown> = {};
      if (opts.from) range.$gte = opts.from;
      if (opts.to) range.$lte = opts.to;
      if (opts.from && opts.to && opts.to <= opts.from) throw new AppError(400, '时间范围无效');
      filter.startTime = range;
    }
  }

  const total = await ActivityModel.countDocuments(filter);
  if (total === 0) throw new AppError(404, '选中的轨迹没有可导出的坐标明细');
  if (total > cap) {
    throw new AppError(400, `共 ${total} 条，超出单次导出上限 ${cap} 条，请缩小时间范围，或按运动类型分批导出`);
  }

  const archive = new ZipArchive({ zlib: { level: 9 } });
  const done = (async () => {
    for (let skip = 0; skip < total; skip += ZIP_BATCH) {
      const docs = await ActivityModel.find(filter)
        .sort({ startTime: -1, _id: 1 })
        .skip(skip)
        .limit(ZIP_BATCH)
        .lean();
      for (const doc of docs) {
        const name = `${bjDateTime(doc.startTime).slice(0, 10)}_${typeLabel(String(doc.type))}_${String(doc._id)}.gpx`;
        archive.append(toGpx(doc), { name });
      }
    }
    archive.append(readmeBody(total), { name: '导出说明.txt' });
    await archive.finalize();
  })();
  return { archive, done, count: total };
}

/* ───────────────────────── 足迹 CSV（2026-11-06） ───────────────────────── */

const FOOTPRINT_CSV_HEADER =
  '足迹ID,到访日期,标题,分类,地点,详细地址,省份,城市,同行人,描述,图片数,经度,纬度';

/** 毫秒时间戳 → 东八区 YYYY-MM-DD（visitDate 是自然日字符串，字典序即时间序） */
function bjDate(ms: number): string {
  return new Date(ms + BJ_OFFSET_MS).toISOString().slice(0, 10);
}

type FootprintCsvOpts = {
  userId: string;
  /** 与活动导出同一口径的 ms 时间窗；visitDate 按 [from, to] 换算成自然日区间 */
  from?: number;
  to?: number;
  cap: number;
};

/**
 * 足迹 CSV 流：本人全部足迹（描述全文在列）。行量小（个人足迹量级），
 * 一次查全即可，不需要像活动汇总那样分批投影。
 */
export async function exportFootprintCsv(opts: FootprintCsvOpts): Promise<Readable> {
  const filter: Record<string, unknown> = { userId: new Types.ObjectId(opts.userId) };
  const range: Record<string, unknown> = {};
  if (opts.from) range.$gte = bjDate(opts.from);
  if (opts.to) range.$lte = bjDate(opts.to);
  if (opts.from && opts.to && opts.to <= opts.from) throw new AppError(400, '时间范围无效');
  if (Object.keys(range).length) filter.visitDate = range;

  const total = await FootprintRecordModel.countDocuments(filter);
  if (total === 0) throw new AppError(404, '没有符合条件的足迹记录');
  if (total > opts.cap) {
    throw new AppError(400, `共 ${total} 条，超出单次导出上限 ${opts.cap} 条，请缩小时间范围`);
  }

  const pass = new PassThrough();
  const pump = async () => {
    pass.write(`\uFEFF${FOOTPRINT_CSV_HEADER}\r\n`);
    const rows = await FootprintRecordModel.find(filter).sort({ visitDate: -1, _id: 1 }).lean();
    for (const r of rows) {
      const line = [
        String(r._id),
        r.visitDate,
        r.title,
        footprintCategoryLabel(r.category || ''),
        r.location?.name || '',
        r.location?.address || '',
        r.location?.province || '',
        r.location?.city || '',
        (r.people || []).join('、'),
        r.description || '',
        (r.photos || []).length,
        r.location?.longitude ?? '',
        r.location?.latitude ?? '',
      ]
        .map(csvEscape)
        .join(',');
      if (!pass.write(`${line}\r\n`)) await new Promise<void>((resolve) => pass.once('drain', resolve));
    }
    pass.end();
  };
  void pump().catch((e) => pass.destroy(e));
  return pass;
}

/* ───────────────────────── 照片打包 zip（2026-11-06） ───────────────────────── */

/** 照片打包上限（张）：原图走 OSS 出网，单包太大既慢又烧流量；超出提示分批 */
export const EXPORT_PHOTOS_MAX_ITEMS = 200;

/** OSS 对象单张下载上限（10MB）：防脏数据里的巨型对象拖死导出 */
const PHOTO_MAX_BYTES = 10 * 1024 * 1024;

function photosReadme(stats: { activities: number; footprints: number; ok: number; failed: string[]; total: number }): string {
  const lines = [
    '小迹一下 · 照片导出',
    `导出时间：${bjDateTime(Date.now())}（东八区）`,
    `照片总数：${stats.total} 张（成功打包 ${stats.ok} 张）`,
    `来源：轨迹打点 ${stats.activities} 条 · 足迹 ${stats.footprints} 条`,
    '',
    '目录结构：轨迹/开始日期_类型_轨迹ID/photo-N.jpg；足迹/到访日期_足迹ID/photo-N.jpg',
    '轨迹ID 与「运动记录 CSV」的轨迹ID 列一致，可据此关联。',
  ];
  if (stats.failed.length) {
    lines.push('', `以下 ${stats.failed.length} 张对象已不存在或下载失败，未包含在包内：`, ...stats.failed);
  }
  return lines.join('\n');
}

/**
 * 照片打包 zip 流：轨迹打点 photos（含旧字段 photoUrl 兜底）+ 足迹 photos 两个来源。
 * 逐张从 OSS 原图下载后 append 进归档（signed URL + axios，10MB 单张上限）；
 * 单张失败不炸整包——记录进「导出说明.txt」（历史脏数据：库里挂着、对象已删很常见）。
 */
export async function exportPhotosZip(opts: {
  userId: string;
  from?: number;
  to?: number;
  cap?: number;
}): Promise<{ archive: Archiver; done: Promise<void>; count: number }> {
  const cap = opts.cap ?? EXPORT_PHOTOS_MAX_ITEMS;
  const uid = Types.ObjectId.isValid(opts.userId) ? new Types.ObjectId(opts.userId) : opts.userId;
  const dateRange: Record<string, unknown> = {};
  if (opts.from) dateRange.$gte = bjDate(opts.from);
  if (opts.to) dateRange.$lte = bjDate(opts.to);

  // 轨迹：与 GPX 同款范围（startTime ms）；足迹：visitDate 自然日区间
  const actFilter: Record<string, unknown> = { status: 'finished', userId: uid, 'markers.0': { $exists: true } };
  if (opts.from || opts.to) {
    const range: Record<string, unknown> = {};
    if (opts.from) range.$gte = opts.from;
    if (opts.to) range.$lte = opts.to;
    if (opts.from && opts.to && opts.to <= opts.from) throw new AppError(400, '时间范围无效');
    actFilter.startTime = range;
  }
  const fpFilter: Record<string, unknown> = { userId: uid };
  if (Object.keys(dateRange).length) fpFilter.visitDate = dateRange;

  const [activities, footprints] = await Promise.all([
    ActivityModel.find(actFilter).select('type startTime markers').sort({ startTime: -1, _id: 1 }).lean(),
    FootprintRecordModel.find(fpFilter).select('visitDate photos').sort({ visitDate: -1, _id: 1 }).lean(),
  ]);

  // 先盘点总数再动 OSS：超限直接 400，别让用户等了半天才报错
  type PhotoEntry = { url: string; name: string };
  const entries: PhotoEntry[] = [];
  for (const doc of activities) {
    const dir = `轨迹/${bjDateTime(Number(doc.startTime)).slice(0, 10)}_${typeLabel(String(doc.type))}_${String(doc._id)}`;
    let n = 0;
    for (const m of doc.markers ?? []) {
      const urls = [...(m.photos || []), ...(m.photoUrl ? [m.photoUrl] : [])];
      for (const url of new Set(urls.map((u: string) => String(u).split('?')[0]))) {
        if (!url) continue;
        n += 1;
        const ext = url.toLowerCase().endsWith('.png') ? '.png' : '.jpg';
        entries.push({ url, name: `${dir}/photo-${n}${ext}` });
      }
    }
  }
  for (const fp of footprints) {
    let n = 0;
    for (const url of new Set<string>((fp.photos || []).map((u: string) => String(u).split('?')[0]))) {
      if (!url) continue;
      n += 1;
      const ext = url.toLowerCase().endsWith('.png') ? '.png' : '.jpg';
      entries.push({ url, name: `足迹/${fp.visitDate}_${String(fp._id)}/photo-${n}${ext}` });
    }
  }
  if (entries.length === 0) throw new AppError(404, '选中的范围没有可导出的照片');
  if (entries.length > cap) {
    throw new AppError(400, `共 ${entries.length} 张照片，超出单次打包上限 ${cap} 张，请缩小时间范围分批导出`);
  }

  const archive = new ZipArchive({ zlib: { level: 6 } }); // 图片已压缩，zlib 再高只烧 CPU 不省体积
  const failed: string[] = [];
  const done = (async () => {
    for (const entry of entries) {
      try {
        // 原图（不带图片处理参数）：导出要保真；第三方域名（非本桶）原样返回也能拉。
        // **流式 append**（2026-11-06 优化）：原先 responseType:'arraybuffer' 把每张整块读进内存
        // 再 append，200 张 × 单张上限 10MB 的理论峰值能到 2G —— 2G 内存的机器扛不住。
        // 改成流式后内存与张数脱钩；且 axios 在**收到响应头**时就会 reject（404/超时），
        // 所以「坏对象」依旧在 append 之前被识别、照旧进 failed 清单（本次失败语义不变）。
        const res = await axios.get(getSignedUrl(entry.url, 600), {
          responseType: 'stream',
          timeout: 20000,
          maxContentLength: PHOTO_MAX_BYTES,
        });
        archive.append(res.data as unknown as Readable, { name: entry.name });
      } catch {
        failed.push(entry.name); // 单张失败不炸整包，说明.txt 里交代
      }
    }
    archive.append(
      photosReadme({
        activities: activities.length,
        footprints: footprints.length,
        ok: entries.length - failed.length,
        failed,
        total: entries.length,
      }),
      { name: '导出说明.txt' },
    );
    await archive.finalize();
  })();
  return { archive, done, count: entries.length };
}
