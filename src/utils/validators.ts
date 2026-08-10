import { z } from 'zod';

/** 登录：微信 code2session 换取 openid */
export const LoginSchema = z.object({
  code: z.string().min(1, '缺少微信登录 code'),
});

/** 刷新 token */
export const RefreshSchema = z.object({
  refreshToken: z.string().min(1, '缺少 refreshToken'),
});

/** 更新个人资料 */
export const UpdateMeSchema = z
  .object({
    nickname: z.string().trim().min(1, '昵称不能为空').max(30, '昵称最长 30 字').optional(),
    avatarUrl: z.string().url('头像地址不合法').max(500).optional(),
    gender: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
    settings: z
      .object({
        unit: z.enum(['metric', 'imperial']).optional(),
        defaultType: z.string().optional(),
        highAccuracy: z.boolean().optional(),
      })
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, '没有可更新的字段');

/** 请求 STS 凭证 */
export const StsSchema = z.object({
  dir: z.string().regex(/^[a-z0-9-]+$/, '目录名只允许小写字母/数字/中划线').optional(),
});

export type LoginInput = z.infer<typeof LoginSchema>;
export type RefreshInput = z.infer<typeof RefreshSchema>;
export type UpdateMeInput = z.infer<typeof UpdateMeSchema>;
