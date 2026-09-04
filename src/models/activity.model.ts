import mongoose from 'mongoose';
import {
  ACTIVITY_STATUS,
  ACTIVITY_TYPES,
  MARKER_TYPES,
  MAX_TRACK_POINTS,
} from '../config/constants.js';

const { Schema, model, models } = mongoose;

const trackPointSchema = new Schema(
  {
    seq: { type: Number, required: true }, // 客户端序号，幂等去重键
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    altitude: { type: Number, default: null },
    speed: { type: Number, default: null },
    accuracy: { type: Number, default: null }, // 水平精度（米，实时定位质量）
    pauseGap: { type: Boolean, default: false }, // 暂停恢复后首个有效点（渲染时断开连线）
    timestamp: { type: Number, required: true },
  },
  { _id: false },
);

const markerSchema = new Schema(
  {
    id: { type: String, required: true }, // 客户端生成 ID
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    timestamp: { type: Number, required: true },
    type: { type: String, enum: MARKER_TYPES, default: 'checkpoint' },
    icon: { type: String, default: '' }, // 打点图标（emoji，用户可选）
    label: { type: String, default: '' }, // 打点文案（用户自定义）
    note: { type: String, default: '' },
    photoUrl: { type: String, default: '' }, // 兼容旧数据（首图）
    photos: { type: [String], default: [] }, // 多图（上限 3，前端约束）
    address: { type: String, default: '' },
  },
  { _id: false },
);

const activitySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: ACTIVITY_TYPES, required: true },
    status: { type: String, enum: ACTIVITY_STATUS, default: 'in_progress', index: true },

    startTime: { type: Number, required: true },
    endTime: { type: Number, default: null },
    duration: { type: Number, default: 0 }, // 秒（扣除暂停）
    distance: { type: Number, default: 0 }, // 米
    avgPace: { type: Number, default: null }, // 全程平均配速（秒/公里）
    fastestKm: { type: Number, default: null }, // 轨迹内最快 1km 分段（秒/公里）
    calories: { type: Number, default: 0 },
    elevationGain: { type: Number, default: 0 },
    maxAltitude: { type: Number, default: null },
    startAddress: { type: String, default: '' },
    endAddress: { type: String, default: '' },
    // 落库省市（点亮地图按省查询用；finish/导入时由离线 locateRegion 计算写入）
    provinces: { type: [String], default: [] }, // 轨迹经过的省（去重）
    startProvince: { type: String, default: '' },
    startCity: { type: String, default: '' },

    trackPoints: {
      type: [trackPointSchema],
      default: [],
      validate: {
        validator: (v: unknown[]) => v.length <= MAX_TRACK_POINTS,
        message: `轨迹点超出上限 ${MAX_TRACK_POINTS}`,
      },
    },
    markers: { type: [markerSchema], default: [] },

    lastPointSeq: { type: Number, default: 0 }, // 已接收最大 seq（幂等去重）
    pausedMs: { type: Number, default: 0 },
    deviceInfo: { type: Schema.Types.Mixed, default: null },
    note: { type: String, default: '' }, // 备注（用户编辑）
  },
  { timestamps: true },
);

// 列表查询：用户 + 状态 + 开始时间倒序
activitySchema.index({ userId: 1, status: 1, startTime: -1 });
// 按省查询轨迹（点亮地图省下钻）：provinces 为多键索引
activitySchema.index({ userId: 1, provinces: 1 });

export type Activity = mongoose.InferSchemaType<typeof activitySchema>;

export const ActivityModel = models.Activity ?? model('Activity', activitySchema);
