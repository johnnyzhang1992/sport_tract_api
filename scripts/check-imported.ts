import mongoose from 'mongoose';
const MONGO = 'mongodb://root:REDACTED@127.0.0.1:27017/sport-track-dev?authSource=admin';
await mongoose.connect(MONGO);
const db = mongoose.connection.db;
const id = '6a7c2e3203335fc26ca047b5';
const doc = await db.collection('activities').findOne({ _id: new mongoose.Types.ObjectId(id) });
if (!doc) {
  console.log('❌ 活动不存在（可能已被删除，或 id 有误）');
  // 找最近的导入活动
  const recent = await db.collection('activities').find({ deviceInfo: { $exists: true } }).sort({ createdAt: -1 }).limit(3).toArray();
  recent.forEach((r) => console.log('最近导入:', r._id.toString(), r.type, 'userId=', String(r.userId), 'points=', (r.trackPoints || []).length));
} else {
  console.log('活动存在: type=', doc.type, 'userId=', String(doc.userId), 'points=', (doc.trackPoints || []).length, 'status=', doc.status);
}
await mongoose.disconnect();
