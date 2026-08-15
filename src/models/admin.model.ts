import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const { Schema, model, models } = mongoose;

/**
 * 管理员账号（管理后台）：密码 bcrypt 哈希存储，支持修改
 */
const adminSchema = new Schema(
  {
    username: { type: String, required: true, unique: true, trim: true },
    passwordHash: { type: String, required: true },
    createdAt: { type: Number, default: () => Date.now() },
  },
  { versionKey: false },
);

/** 哈希密码 */
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

/** 校验密码 */
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export type AdminDoc = {
  _id: unknown;
  username: string;
  passwordHash: string;
  createdAt: number;
};

export const AdminModel = models.Admin ?? model('Admin', adminSchema);
