import { UserUidCounterModel } from '../models/user-uid-counter.model.js';
import { UserModel } from '../models/user.model.js';

/** 用户 UID 起始编号（1000） */
export const USER_UID_START = 1000;

/** 原子取下一个 UID（从 1000 开始） */
export async function nextUserUid(): Promise<number> {
  const doc = await UserUidCounterModel.findOneAndUpdate(
    { _id: 'userUid' },
    [{ $set: { value: { $add: [{ $ifNull: ['$value', USER_UID_START - 1] }, 1] } } }],
    { new: true, upsert: true, updatePipeline: true },
  );
  return doc?.value ?? USER_UID_START;
}

/** 批量补 UID：按创建时间升序给缺 UID 的用户补号（只补编号，不动昵称） */
export async function backfillUsers(): Promise<{ uidBackfilled: number }> {
  const missing = await UserModel.find({ uid: { $exists: false } })
    .sort({ createdAt: 1 })
    .select('_id')
    .lean();
  for (const u of missing) {
    const uid = await nextUserUid();
    await UserModel.updateOne({ _id: u._id }, { $set: { uid } });
  }
  return { uidBackfilled: missing.length };
}

/** 批量补默认昵称：给空昵称用户补 迹路者{uid}（基于已分配 UID；有昵称不覆盖） */
export async function backfillEmptyNicknames(): Promise<number> {
  const empty = await UserModel.find({ nickname: { $in: ['', null] }, uid: { $exists: true } })
    .select('_id uid')
    .lean();
  for (const u of empty) {
    await UserModel.updateOne({ _id: u._id }, { $set: { nickname: `迹路者${u.uid}` } });
  }
  return empty.length;
}
