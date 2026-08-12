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

// ==================== 运动记录（M2） ====================

const TrackPointSchema = z.object({
  seq: z.number().int().positive('seq 必须为正整数'),
  lat: z.number().min(-90).max(90, '纬度不合法'),
  lng: z.number().min(-180).max(180, '经度不合法'),
  altitude: z.number().nullable().optional(),
  // 负数 speed（微信定位异常值）容错归 null
  speed: z.number().nullable().optional().default(null).transform((v) => (v != null && v < 0 ? null : v)),
  accuracy: z.number().min(0).nullable().optional(), // 水平精度（米）
  timestamp: z.number().positive('时间戳不合法'),
});

/** 创建活动 */
export const CreateActivitySchema = z.object({
  type: z.enum(['hiking', 'walking', 'running', 'cycling', 'mountaineering', 'swimming'], {
    message: '运动类型不合法',
  }),
  startTime: z.number().positive('开始时间不合法'),
  deviceInfo: z.record(z.string(), z.unknown()).optional(),
});

/** 增量上传轨迹点 */
export const AppendPointsSchema = z.object({
  fromSeq: z.number().int().nonnegative().optional(),
  points: z
    .array(TrackPointSchema)
    .min(1, 'points 不能为空')
    .max(2000, '单次最多上传 2000 个点'),
});

/** 打点类型 */
export const MarkerTypeSchema = z.enum(['checkpoint', 'rest', 'photo', 'note']);

/** 照片 URL：允许空字符串（未拍照）或合法 URL */
const PhotoUrlSchema = z.union([z.literal(''), z.string().url('照片地址不合法').max(500)]);

/** 多图数组（上限 3 张，决策 F11：打卡点可带多张现场照片） */
const PhotosSchema = z.array(PhotoUrlSchema).max(3, '每个打卡点最多 3 张图片').default([]);

/** 新增打点 */
export const CreateMarkerSchema = z.object({
  id: z.string().min(1).max(64),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  timestamp: z.number().positive(),
  type: MarkerTypeSchema.default('checkpoint'),
  note: z.string().max(500).default(''),
  photoUrl: PhotoUrlSchema.optional().default(''),
  photos: PhotosSchema.optional(),
  address: z.string().max(200).optional().default(''),
});

/** 编辑打点（photos 传入时全量替换） */
export const UpdateMarkerSchema = z.object({
  type: MarkerTypeSchema.optional(),
  note: z.string().max(500).optional(),
  photoUrl: PhotoUrlSchema.optional(),
  photos: PhotosSchema.optional(),
  address: z.string().max(200).optional(),
});

/** 结束活动（final 包，服务端对账） */
export const FinishActivitySchema = z.object({
  trackPoints: z.array(TrackPointSchema).max(20000, '轨迹点超出上限'),
  markers: z.array(CreateMarkerSchema).optional(),
  startAddress: z.string().max(200).optional().default(''),
  endAddress: z.string().max(200).optional().default(''),
  pausedMs: z.number().optional().default(0).transform((v) => (v != null && v < 0 ? 0 : v)),
  endTime: z.number().positive('结束时间不合法').optional(),
  weightKg: z.number().positive().max(300).optional(),
  deviceInfo: z.record(z.string(), z.unknown()).optional(),
});

/** 活动列表查询（type 空字符串视为不筛选） */
export const ListActivitiesQuery = z.object({
  type: z
    .union([
      z.enum(['hiking', 'walking', 'running', 'cycling', 'mountaineering', 'swimming']),
      z.literal(''),
    ])
    .optional(),
  month: z.string().regex(/^\d{4}-\d{2}$/, 'month 格式应为 YYYY-MM').optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

export type LoginInput = z.infer<typeof LoginSchema>;
export type RefreshInput = z.infer<typeof RefreshSchema>;
export type UpdateMeInput = z.infer<typeof UpdateMeSchema>;
export type CreateActivityInput = z.infer<typeof CreateActivitySchema>;
export type AppendPointsInput = z.infer<typeof AppendPointsSchema>;
export type CreateMarkerInput = z.infer<typeof CreateMarkerSchema>;
export type UpdateMarkerInput = z.infer<typeof UpdateMarkerSchema>;
export type FinishActivityInput = z.infer<typeof FinishActivitySchema>;
export type ListActivitiesQueryInput = z.infer<typeof ListActivitiesQuery>;
