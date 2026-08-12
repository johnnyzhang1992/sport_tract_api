/** 清理重复 seed 数据：第一遍插入时 label 被 schema 剥离（无标记），与 SEED 数据 trackPoints 完全相同的删除 */
import mongoose from 'mongoose';
const MONGO = 'mongodb://root:REDACTED@127.0.0.1:27017/sport-track-dev?authSource=admin';
await mongoose.connect(MONGO);
const db = mongoose.connection.db;
const uid = new mongoose.Types.ObjectId('6a7ab349398adc2c86b4c1ba');
const coll = db.collection('activities');
const seeded = await coll.find({ userId: uid, label: 'SEED' }).toArray();
// 对每条 SEED 计算 trackPoints 指纹，找出无 label 且指纹相同的
const fp = (a) => JSON.stringify((a || []).map((p) => [p.lat, p.lng]));
const seedFps = new Set(seeded.map((s) => fp(s.trackPoints)));
const dupes = await coll
  .find({ userId: uid, $or: [{ label: { $ne: 'SEED' } }, { label: { $exists: false } }] })
  .toArray();
let removed = 0;
for (const d of dupes) {
  if (seedFps.has(fp(d.trackPoints))) {
    await coll.deleteOne({ _id: d._id });
    removed++;
    console.log('删除重复:', d._id.toString(), d.type, d.startTime);
  }
}
console.log(`共删除 ${removed} 条重复 seed`);
await mongoose.disconnect();
