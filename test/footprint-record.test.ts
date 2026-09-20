import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Types } from 'mongoose';
import { buildApp } from '../src/app.js';
import { FootprintRecordModel } from '../src/models/footprint-record.model.js';
import { CreateFootprintRecordSchema } from '../src/utils/validators.js';

// 模型用例要真实落库，沿用仓库惯例用 buildApp 建 Mongo 连接（Task 2 的接口用例复用同一 app）
let app: Awaited<ReturnType<typeof buildApp>>;

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

after(async () => {
  await app.close();
  const mongoose = (await import('mongoose')).default;
  await mongoose.disconnect().catch(() => {});
});

const baseDoc = {
  userId: new Types.ObjectId(),
  visitDate: '2024-05-01',
  title: '足迹测试-模型',
  location: { latitude: 30.24, longitude: 120.15 },
};

// 模型层只验必填与默认值；日期格式在 zod 层校验（模型存任意日期字符串合法）
test('模型：合法文档可保存，默认值生效，必填缺失被拒绝', async () => {
  const doc = await FootprintRecordModel.create(baseDoc);
  assert.equal(doc.title, '足迹测试-模型');
  assert.deepEqual(doc.photos, []);
  assert.deepEqual(doc.people, []);
  assert.equal(doc.description, '');
  assert.equal(doc.location.province, ''); // 省市由服务层补，模型默认空串
  await assert.rejects(FootprintRecordModel.create({ ...baseDoc, title: undefined }));
  await assert.rejects(FootprintRecordModel.create({ ...baseDoc, location: { latitude: 1 } })); // 缺 longitude
  await FootprintRecordModel.deleteOne({ _id: doc._id });
});

test('zod：visitDate 必须 YYYY-MM-DD；people≤10 每项≤20 字；photos≤3；标题 1-50', () => {
  const ok = CreateFootprintRecordSchema.parse({
    visitDate: '2024-05-01', title: 'a'.repeat(50),
    people: ['张三', '李四'], description: 'x',
    location: { name: '西湖', address: '杭州市西湖区', latitude: 30.24, longitude: 120.15 },
    photos: [],
  });
  assert.equal(ok.people.length, 2);
  assert.equal(ok.visitDate, '2024-05-01'); // 合法日历日通过
  assert.equal(CreateFootprintRecordSchema.parse({ ...ok, visitDate: '2024-02-29' }).visitDate, '2024-02-29'); // 闰日合法
  assert.throws(() => CreateFootprintRecordSchema.parse({ ...ok, visitDate: '2024-5-1' }));
  assert.throws(() => CreateFootprintRecordSchema.parse({ ...ok, visitDate: '2024-13-45' })); // 格式对但日历不存在
  assert.throws(() => CreateFootprintRecordSchema.parse({ ...ok, visitDate: '2023-02-29' })); // 非闰年 2 月 29
  assert.throws(() => CreateFootprintRecordSchema.parse({ ...ok, title: '' }));
  assert.throws(() => CreateFootprintRecordSchema.parse({ ...ok, title: 'a'.repeat(51) }));
  assert.throws(() => CreateFootprintRecordSchema.parse({ ...ok, people: Array(11).fill('甲') }));
  assert.throws(() => CreateFootprintRecordSchema.parse({ ...ok, people: ['a'.repeat(21)] }));
  assert.throws(() => CreateFootprintRecordSchema.parse({ ...ok, photos: ['u?1', 'u?2', 'u?3', 'u?4'].map((s) => `https://e.com/${s}.jpg`) }));
  assert.throws(() => CreateFootprintRecordSchema.parse({ ...ok, description: 'x'.repeat(501) }));
  assert.throws(() => CreateFootprintRecordSchema.parse({ ...ok, location: { ...ok.location, latitude: 91 } }));
});
