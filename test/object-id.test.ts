import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Types } from 'mongoose';
import { isObjectIdLike, assertObjectIdLike } from '../src/utils/object-id.js';
import { AppError } from '../src/utils/app-error.js';

// 闸门形态：只认 24 位 hex 串与 ObjectId 实例；不用 Types.ObjectId.isValid 的宽松口径
const HEX24 = '507f1f77bcf86cd799439011';

test('isObjectIdLike：24 位 hex（含大写）与 ObjectId 实例放行，其余形态拒绝', () => {
  assert.equal(isObjectIdLike(HEX24), true);
  assert.equal(isObjectIdLike(HEX24.toUpperCase()), true, 'hex 大小写都算（DB 里存的是小写，但入参不该因大小写炸）');
  assert.equal(isObjectIdLike(new Types.ObjectId(HEX24)), true, '内部调用方直接传实例');
  assert.equal(isObjectIdLike('not-an-objectid'), false);
  assert.equal(isObjectIdLike('abc'), false);
  assert.equal(isObjectIdLike(''), false);
  assert.equal(isObjectIdLike(`${HEX24}x`), false, '25 位');
  assert.equal(isObjectIdLike(HEX24.slice(1)), false, '23 位');
  assert.equal(isObjectIdLike('g' + HEX24.slice(1)), false, '非 hex 字符');
  // 与 mongoose isValid 的实测差异：它放过 12 字节 Buffer，本闸门不放过（路径参数只可能是字符串）
  assert.equal(Types.ObjectId.isValid(Buffer.from('abcdefghijkl')), true, '对照：mongoose 9.9.2 认为 12 字节 Buffer 合法');
  assert.equal(isObjectIdLike(Buffer.from('abcdefghijkl')), false);
  assert.equal(isObjectIdLike('abcdefghijkl'), false);
  assert.equal(isObjectIdLike(123456), false);
  assert.equal(isObjectIdLike(null), false);
  assert.equal(isObjectIdLike(undefined), false);
});

test('assertObjectIdLike：合法形态原样返回，非法一律 404 且用调用方给的资源文案', () => {
  assert.equal(assertObjectIdLike(HEX24, '活动不存在'), HEX24);
  const oid = new Types.ObjectId(HEX24);
  assert.equal(assertObjectIdLike(oid, '足迹不存在'), oid);
  for (const msg of ['活动不存在', '足迹不存在', '用户不存在', '专题不存在']) {
    assert.throws(() => assertObjectIdLike('bad-id', msg), (err: unknown) => {
      assert.ok(err instanceof AppError, `应抛 AppError，实际 ${String(err)}`);
      assert.equal((err as AppError).statusCode, 404);
      assert.equal((err as AppError).message, msg, '文案必须带资源语义，不能是笼统的「参数不合法」');
      return true;
    });
  }
});
