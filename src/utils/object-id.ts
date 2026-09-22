import { Types } from 'mongoose';
import { AppError } from './app-error.js';

/** 服务层入参形态：路由带来的是字符串，内部调用方常直接传 ObjectId 实例 */
export type ObjectIdLike = Types.ObjectId | string;

const HEX24_RE = /^[a-f\d]{24}$/i;

/**
 * 形态判定：只认 24 位 hex 串或 ObjectId 实例。
 * 不直接用 `Types.ObjectId.isValid`——本机 mongoose 9.9.2 实测它还放过 12 字节 Buffer
 * （`isValid(Buffer.from('abcdefghijkl')) === true`），而路径参数只可能是字符串；
 * 判定口径写死成 24 位 hex 更可控，也和 topic 服务原有的 `OBJECT_ID_RE` 一致。
 */
export function isObjectIdLike(value: unknown): value is ObjectIdLike {
  if (value instanceof Types.ObjectId) return true;
  return typeof value === 'string' && HEX24_RE.test(value);
}

/**
 * 客户端 id 闸门：形态不合法即按「资源不存在」404。
 *
 * 不拦的话，畸形串会直接进 mongoose 的 `_id`（或任何 ObjectId 路径）查询并抛 CastError，
 * 而全局 error-handler 不认识 CastError → 落 500 分支，dev 环境还会把
 * 「Cast to ObjectId failed for value ... for model ...」这种内部文案透给客户端。
 * 这类 id 不可能对应任何文档，语义上就是 404；且拦在查询之前，写接口也不会带副作用。
 *
 * @param notFoundMessage 资源级文案（'活动不存在' / '足迹不存在' / '用户不存在'…），与各 service 既有 404 一致
 */
export function assertObjectIdLike(value: unknown, notFoundMessage: string): ObjectIdLike {
  if (!isObjectIdLike(value)) throw new AppError(404, notFoundMessage);
  return value;
}
