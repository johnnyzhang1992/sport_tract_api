import { Types } from 'mongoose';
import { WerunDayModel } from '../models/werun-day.model.js';
import { bjDateStr } from '../utils/bj-time.js';
import { AppError } from '../utils/app-error.js';
import { csvEscape, EXPORT_CSV_MAX_ROWS } from './export.js';
import { werunWeekday } from './werun-stats.js';

/**
 * 微信步数 CSV（2026-11-06）：
 * - 只导有同步记录的天（与「每日明细」口径一致，未同步的日期不补零）；
 * - 时间范围沿用导出页的 from/to（ms），换算成东八区自然日区间，首尾都含；
 * - 按日期升序，便于直接在表格里做时间序列。
 */
const CSV_HEADER = '日期,星期,步数';

export async function exportWerunCsv(opts: {
  userId: string;
  from?: number;
  to?: number;
  cap?: number;
}): Promise<string> {
  const cap = opts.cap ?? EXPORT_CSV_MAX_ROWS;
  if (!Types.ObjectId.isValid(opts.userId)) throw new AppError(400, '无效的用户 ID');
  if (opts.from != null && !Number.isFinite(opts.from)) throw new AppError(400, '时间范围无效');
  if (opts.to != null && !Number.isFinite(opts.to)) throw new AppError(400, '时间范围无效');
  if (opts.from != null && opts.to != null && opts.to <= opts.from) throw new AppError(400, '时间范围无效');

  const date: Record<string, string> = {};
  if (opts.from != null) date.$gte = bjDateStr(opts.from);
  // to 用「减 1ms 再取日」：两种常见传法都对——
  //   MP 传的是当天 23:59:59.999（含当天）→ 减 1ms 仍落在同一天；
  //   与 /overview、/werun/report 同口径的排他边界（次日 00:00）→ 减 1ms 正好落到窗口最后一天。
  // 直接 bjDateStr(to) 会在排他边界上多带一天，与报告页口径不一致（2026-11-06 审出）。
  if (opts.to != null) date.$lte = bjDateStr(opts.to - 1);
  const filter: Record<string, unknown> = { userId: new Types.ObjectId(opts.userId) };
  if (Object.keys(date).length) filter.date = date;

  const total = await WerunDayModel.countDocuments(filter);
  if (total === 0) throw new AppError(404, '没有符合条件的步数记录');
  if (total > cap) {
    throw new AppError(400, `共 ${total} 天，超出单次导出上限 ${cap} 天，请缩小时间范围`);
  }

  const rows = await WerunDayModel.find(filter)
    .select({ date: 1, step: 1 })
    .sort({ date: 1 })
    .lean();
  const lines = [CSV_HEADER];
  for (const r of rows) {
    lines.push([r.date, werunWeekday(r.date), Number(r.step) || 0].map(csvEscape).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
