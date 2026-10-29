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
    // 五个稀疏布尔一律不设 default(false)：缺省保持缺省，$push 落库才是稀疏的，
    // 消费方（compact/normalize/清洗/渲染）一律按 truthy / === true 判
    pauseGap: { type: Boolean }, // 暂停恢复后首个有效点（渲染时断开连线）
    still: { type: Boolean }, // 静止时段检测标出的点（finish 时算，见 utils/standstill.ts）
    vehicle: { type: Boolean }, // 非运动段检测标出的点，疑似乘车（见 utils/vehicle.ts）；端上实时超速标记同字段
    gapJump: { type: Boolean }, // 采样断档连线的落点（渲染时在此断开，见 utils/track-gap.ts）
    accBad: { type: Boolean }, // 端上精度差但抽稀保留的点（accuracy 超类型阈值；弱信号段保渲染连续性）
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
    // 轨迹是否已纠偏：finish 落库原始点默认 false；用户点「纠偏」跑管线后置 true。
    // 2026-09-27 前的旧轨迹经自动管线落库，默认视为已纠偏
    corrected: { type: Boolean, default: true },

    startTime: { type: Number, required: true },
    endTime: { type: Number, default: null },
    duration: { type: Number, default: 0 }, // 秒（扣除暂停）
    standstillMs: { type: Number, default: 0 }, // 自动暂停：finish 时判出的静止时段总时长（毫秒）
    vehicleMs: { type: Number, default: 0 }, // 非运动段：疑似乘车的总时长（毫秒），与 standstillMs 一样从 duration 里扣
    vehicleM: { type: Number, default: 0 }, // 非运动段：被剔掉的位移（米）
    distance: { type: Number, default: 0 }, // 米
    avgPace: { type: Number, default: null }, // 全程平均配速（秒/公里）
    fastestKm: { type: Number, default: null }, // 轨迹内最快 1km 分段（秒/公里）
    // 表现分（ITRA 风格幂律评分，仅类跑步类型；utils/perf-score.ts）
    perfScore: { type: Number, default: null },
    // 漂移置信度分（0-100，utils/drift-score.ts）：PB/榜单进榜资格门禁用，
    // null = 未评估（导入/planned/老数据，视为可信）；≥ DRIFT_SCORE_PB_GATE 不进榜
    driftScore: { type: Number, default: null },
    // 实跑/规划判别（导入时判定；采集的轨迹恒为 recorded）
    trackKind: { type: String, enum: ['recorded', 'planned', 'uncertain'], default: 'recorded' },
    // 距离里程碑 PB：到达 5/10/15…公里的累计用时（秒）；finish/reprocess 时算出落库，
    // 历史轨迹由 /stats/best 惰性补算（无标记的写 []，避免反复扫点）
    pbMarks: {
      type: [{ km: { type: Number }, sec: { type: Number } }],
      default: undefined,
    },
    calories: { type: Number, default: 0 },
    elevationGain: { type: Number, default: 0 },
    minAltitude: { type: Number, default: null }, // 轨迹最低海拔（米，GPS 参考）
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

// 防脚本注入：同用户同时只允许一条进行中活动（应用层 findOne 检查有并发窗口，唯一索引兜底）。
// 已有历史 in_progress 数据时建索引会失败——上线前先清理或收尾存量
activitySchema.index(
  { userId: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'in_progress' },
    name: 'unique_in_progress_per_user',
  },
);
// 按省查询轨迹（点亮地图省下钻）：provinces 为多键索引
activitySchema.index({ userId: 1, provinces: 1 });

/**
 * 榜单发分聚合的读路径（services/points-board.ts 的 trustedBoardRows，2026-10-29 终审 must-fix #4）：
 * `$match {type, status:'finished', startTime:{$gte,$lt}}`——四道可信判据（vehicleMs/driftScore/
 * corrected/avgPace）都是同一文档上的过滤，进不了索引，能服务等值+区间的只有这三个字段。
 * 键序：type → status（两个等值）→ startTime（区间收尾），与查询形状一一对应。
 * 不建它时的实际计划是 `status_1` 单键（`{userId,status,startTime}` 缺 type 等值前缀用不上）：
 * 一次结算 pass 的 8 个榜各扫一遍**全部 finished 轨迹**（dev 库实测 1000 keys/1000 docs），
 * 单元一多就是 8×全表，且完成标记过期后每重评一次再付一遍。IDX-1（test/points-board.test.ts）
 * 用 EXPLAIN 钉住它真被选中；guard-index.ts 的两侧自检钉住声明与库里都还在。
 */
activitySchema.index({ type: 1, status: 1, startTime: 1 });

export type Activity = mongoose.InferSchemaType<typeof activitySchema>;

export const ActivityModel = models.Activity ?? model('Activity', activitySchema);
