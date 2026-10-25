import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose, { Types } from 'mongoose';
import { config } from '../src/config/index.js';
import { PointSigninModel, PointTaskModel, PointRecordModel } from '../src/models/point.model.js';

const userId = new Types.ObjectId();
before(async () => {
  // 单文件直跑不会经过 app 的 mongodb 插件，这里自行连接；不连时 Model.init() 会一直 buffering
  await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 5000 });
  // 唯一索引是异步建的，测试必须等 init 完成再断言 E11000
  await Promise.all([PointSigninModel.init(), PointTaskModel.init(), PointRecordModel.init()]);
});
after(async () => {
  await Promise.all([
    PointSigninModel.deleteMany({ userId }),
    PointTaskModel.deleteMany({ userId }),
    PointRecordModel.deleteMany({ userId }),
  ]);
  await mongoose.disconnect().catch(() => {});
});

test('PM1 同日签到只能一条', async () => {
  await PointSigninModel.create({ userId, dateKey: '2026-10-24', streakDay: 1, points: 1, source: 'sign', createdAt: Date.now() });
  await assert.rejects(
    PointSigninModel.create({ userId, dateKey: '2026-10-24', streakDay: 2, points: 2, source: 'sign', createdAt: Date.now() }),
    /E11000/,
  );
});

test('PM2 同一任务同一周期只能领一次', async () => {
  await PointTaskModel.create({ userId, taskKey: 'daily_activity', periodKey: '2026-10-24', status: 'claimed', points: 1, claimedAt: Date.now() });
  await assert.rejects(
    PointTaskModel.create({ userId, taskKey: 'daily_activity', periodKey: '2026-10-24', status: 'claimed', points: 1, claimedAt: Date.now() }),
    /E11000/,
  );
});

test('PM3 idemKey 唯一', async () => {
  const base = { userId, type: 'signin', title: '签到', delta: 1, balanceAfter: 1, bizDate: '2026-10-24', idemKey: 'u:signin:2026-10-24', createdAt: Date.now() };
  await PointRecordModel.create(base);
  await assert.rejects(PointRecordModel.create({ ...base, delta: 2 }), /E11000/);
});
