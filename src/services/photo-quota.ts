import { Types } from 'mongoose';
import { UserModel } from '../models/user.model.js';
import { AppError } from '../utils/app-error.js';
import { entitlementsOf } from './entitlements.js';
import { photoQuotaFullMessage } from '../config/member-copy.js';

/** 带照片的对象：打点是 {photoUrl, photos}，足迹是裸 URL 数组 */
interface PhotoHolder {
  photoUrl?: string;
  photos?: string[];
}

/**
 * 一张照片＝库里一颗 URL。photos 非空时按数组长度算——photoUrl 与 photos[0] 是同一张图的两份
 * 记录，双计会让额度虚高；只有老数据没 photos 时才回退 photoUrl 算 1 张（与下发口径一致）。
 */
export function countPhotos(holder: PhotoHolder | string[] | undefined | null): number {
  if (!holder) return 0;
  // 空串算"没图"：PhotosSchema 允许 ''（未拍照时提交的占位）
  const real = ((Array.isArray(holder) ? holder : holder.photos) ?? []).filter(Boolean);
  if (real.length > 0) return real.length;
  return !Array.isArray(holder) && holder.photoUrl ? 1 : 0;
}

export function countMarkerPhotos(markers: PhotoHolder[] | undefined | null): number {
  return (markers ?? []).reduce((sum, m) => sum + countPhotos(m), 0);
}

export async function getPhotoQuota(
  userId: string,
): Promise<{ used: number; limit: number; remaining: number; isMember: boolean }> {
  // 上限改读权益层（spec §5.4 第 4 处判据）：会员期内是 300，非会员仍是 MAX_USER_PHOTOS
  const [doc, { photoQuotaLimit, memberActive }] = await Promise.all([
    UserModel.findById(userId).select('photoQuotaUsed').lean(),
    entitlementsOf(userId),
  ]);
  const used = doc?.photoQuotaUsed ?? 0;
  return { used, limit: photoQuotaLimit, remaining: Math.max(0, photoQuotaLimit - used), isMember: memberActive };
}

/**
 * 照片额度结算：把 used 从 before 调到 after。
 *
 * 服务端看不到 OSS 直传（POST /oss/credential 只签凭证），所以只能在落库处结算——
 * 于是 used 恒等于「该用户库里存着的照片颗数」，删除/全量替换才能精确回补。
 * 新增类路径（建足迹 / 打点 / finish 对账）在写库前调，扣不动就抛、不留半成品；
 * 删除类路径在写成功后调，写失败不该退额度。结算成功但紧随其后的写失败会留下少量漂移，
 * 上限一次 3 张、只在并发结束那一下发生，可接受（要绝对准得加对账重算）。
 */
export async function settlePhotoQuota(userId: string, before: number, after: number): Promise<void> {
  const delta = after - before;
  if (delta === 0) return;
  const _id = new Types.ObjectId(userId);

  if (delta > 0) {
    // 上限按写入时刻的权益读数取（会员前后上限不同，不能拿常量）；闸门本身仍是条件更新。
    const { photoQuotaLimit, memberActive } = await entitlementsOf(userId);
    const ok = await UserModel.findOneAndUpdate(
      {
        _id,
        $or: [{ photoQuotaUsed: { $lte: photoQuotaLimit - delta } }, { photoQuotaUsed: { $exists: false } }],
      },
      { $inc: { photoQuotaUsed: delta } },
      { new: true, lean: true },
    )
      .select('photoQuotaUsed')
      .exec();
    if (!ok) {
      const { used } = await getPhotoQuota(userId);
      throw new AppError(400, photoQuotaFullMessage(used, photoQuotaLimit, memberActive));
    }
    return;
  }

  const back = -delta;
  const refunded = await UserModel.updateOne({ _id, photoQuotaUsed: { $gte: back } }, { $inc: { photoQuotaUsed: -back } });
  if (refunded.matchedCount === 0) {
    // 账已不平（要退的比已用的多，例如手工清过库）：兜平到 0，别让负数留在表里继续抵扣
    await UserModel.updateOne({ _id }, { $set: { photoQuotaUsed: 0 } });
  }
}
