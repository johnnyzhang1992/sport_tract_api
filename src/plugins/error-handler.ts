import fp from 'fastify-plugin';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from '../utils/app-error.js';

/**
 * 冲突字段组合（keyPattern 排序后以 + 连接）→ 面向用户的 409 文案。
 * 认字段组合而不是索引名：Mongoose 在不同写入路径上不一定透出 index 名。
 * code 必须与应用层主动抛的那个一致，否则客户端要为"被索引拦住"和"被 service 拦住"写两套分支。
 */
const UNIQUE_CONFLICT_COPY: Record<string, { code: string; message: string }> = {
  'status+userId': { code: 'ACTIVITY_IN_PROGRESS', message: '已有进行中的运动，请先结束或放弃' },
  // campaign_members 的 partial unique index（仅约束 state='joined'）：
  // join 的「先查再插」有并发窗口，同一用户同时 join 两次时输的一方由此兜底 → 复用应用层 409 的文案。
  'campaignId+userId': { code: 'ALREADY_JOINED', message: '你已在该活动中' },
};

/**
 * zod 原生英文报错 → 中文的兜底映射（2026-11-18）。
 *
 * 背景：schema 里只给「链上校验」（min/regex 等）配了中文 message，
 * 「字段缺失 / 类型不对」这一层漏出的是 zod 原生英文
 * （`Invalid input: expected string, received undefined`），直接 toast 给用户。
 * LoginSchema/RefreshSchema 已逐字段补了 `{ error }`，但全文件 30+ 字段逐个补不现实也易漏，
 * 所以在这里按 issue 特征兜底；schema 里已有的中文 message 优先，不会被这里覆盖。
 *
 * 匹配策略（宁可粗一点也不要英文漏出去，同时绝不把内部细节反射给用户）：
 *   - `Invalid input: expected X, received undefined` → 字段缺失 → 「缺少N」
 *   - `Invalid input: expected X, received Y`（Y 非 undefined）→ 类型不对 → 「N格式不正确」
 *   - `Too small / Too big` 等其余 → 通用「N不合法」
 * N 取 FIELD_LABELS 里的中文名；没登记的字段用 path 原文（驼峰参数名用户看得懂）。
 */
/** 字段名 → 中文标签（测试也用；见 zodIssueToChinese） */
export const ZOD_FIELD_LABELS: Record<string, string> = {
  code: '微信登录 code',
  uid: '用户编号',
  refreshToken: 'refreshToken',
  encryptedData: '加密数据',
  iv: '加密向量',
  title: '标题',
  description: '描述',
  nickname: '昵称',
  avatarUrl: '头像地址',
  avatarPreset: '头像预设',
  weightKg: '体重',
  heightCm: '身高',
  dir: '目录名',
  seq: '序号',
  lat: '纬度',
  lng: '经度',
  latitude: '纬度',
  longitude: '经度',
  accuracy: '定位精度',
  timestamp: '时间戳',
  startTime: '开始时间',
  endTime: '结束时间',
  type: '运动类型',
  points: '轨迹点',
  fromSeq: '起始序号',
  visitDate: '到访日期',
  location: '位置',
  people: '同行人',
  photos: '照片',
  category: '分类',
  province: '省份',
  month: '月份',
  memberLimit: '人数上限',
  note: '备注',
  day: '日期',
  date: '日期',
  keyword: '关键词',
  confirm: '确认词',
};

/** zod issue → 面向用户的中文文案（导出供测试直接断言，不必起 HTTP） */
export function zodIssueToChinese(issue: { message: string; path: (string | number | symbol)[] }): string {
  // 已是中文（schema 里配过的 message）→ 原样用
  if (/[\u4e00-\u9fa5]/.test(issue.message)) return issue.message;
  // path 里数字下标（数组元素）不参与匹配：`points.0.lat` → 依次找 lat/points 的登记名
  const parts = issue.path.filter((p): p is string => typeof p === 'string');
  const path = parts.join('.');
  // label：从 path 末段往回找第一个登记过的中文名（`points.0.lat` → lat → 「纬度」）；
  // 全未登记且 path 非空时退化为「该字段」——不把 lat/seq 这类英文参数名直接甩给用户。
  // （zod v4 嵌套 issue 的 path 形如 ['points', 0, 'lat']，message 是英文原生串。）
  // ⚠️ find 返回的是**键**，还要再查一次表拿中文（第一版漏了这步，输出「缺少lat」）
  const matchedKey =
    [...parts].reverse().find((p) => p in ZOD_FIELD_LABELS) ??
    (path in ZOD_FIELD_LABELS ? path : undefined);
  const label = matchedKey ? ZOD_FIELD_LABELS[matchedKey] : path ? undefined : '参数';
  // zod v4 原生形态：`Invalid input: expected string, received undefined`
  if (/received\s+undefined/.test(issue.message)) return label ? `缺少${label}` : '缺少必要参数';
  if (/^Invalid input/.test(issue.message)) return label ? `${label}格式不正确` : '请求参数格式不正确';
  if (/^Too (small|big)/.test(issue.message)) return label ? `${label}取值超出范围` : '请求参数取值超出范围';
  return label ? `${label}不合法` : '请求参数不合法';
}

/**
 * 全局错误处理：统一 { success, code, message, data } 响应
 * - AppError：业务错误（保留 statusCode + extra）
 * - ZodError：参数校验错误（400，返回第一条 issue，英文兜底转中文）
 * - 其他：500，生产环境不泄露内部信息
 */
export default fp(
  async (fastify: FastifyInstance) => {
    fastify.setErrorHandler((err: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
      if (err instanceof AppError) {
        return reply.code(err.statusCode).send({
          success: false,
          code: err.statusCode,
          message: err.message,
          data: err.extra ?? null,
        });
      }

      if (err instanceof ZodError) {
        const issue = err.issues[0];
        return reply.code(400).send({
          success: false,
          code: 400,
          message: issue ? zodIssueToChinese(issue) : '参数校验失败',
          data: null,
        });
      }

      // 校验类错误（Fastify schema / body 解析等）
      if (err.validation || err.statusCode === 400) {
        return reply.code(400).send({
          success: false,
          code: 400,
          message: err.message ?? '请求参数不合法',
          data: null,
        });
      }

      // 唯一索引冲突（E11000）：应用层"先查再插"总有并发窗口，兜底靠数据库唯一索引，
      // 但索引抛上来的原文带着集合名、索引名和冲突方的 ObjectId——落到下面的通用分支就是
      // 500 + 内部信息泄露。这里按索引名换成与应用层主动抛的完全同形同码的 409，客户端只认一套。
      const mongo = err as unknown as { code?: number; keyPattern?: Record<string, unknown> };
      if (mongo.code === 11000) {
        const fields = Object.keys(mongo.keyPattern ?? {}).sort();
        const copy = UNIQUE_CONFLICT_COPY[fields.join('+')] ?? {
          code: 'DUPLICATE_KEY',
          // 只报字段名，不回吐 keyValue：那里面可能是别人的 id
          message: `提交的内容与已有记录冲突（重复字段：${fields.join('、') || '未知'}）`,
        };
        return reply.code(409).send({ success: false, code: 409, message: copy.message, data: { code: copy.code } });
      }

      const isDev = process.env.NODE_ENV !== 'production';
      fastify.log.error({ err }, '未处理异常');
      return reply.code(err.statusCode ?? 500).send({
        success: false,
        code: err.statusCode ?? 500,
        message: isDev ? err.message : '服务器内部错误',
        data: null,
      });
    });

    // 未匹配路由 → 404 统一格式
    fastify.setNotFoundHandler((request, reply) => {
      reply.code(404).send({
        success: false,
        code: 404,
        message: `接口不存在: ${request.method} ${request.url}`,
        data: null,
      });
    });
  },
  { name: 'error-handler' },
);
