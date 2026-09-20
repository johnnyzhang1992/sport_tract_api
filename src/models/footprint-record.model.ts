import mongoose from 'mongoose';

const { Schema, model, models } = mongoose;

const locationSchema = new Schema(
  {
    name: { type: String, default: '' }, // 地点名（POI 名或用户自填）
    address: { type: String, default: '' }, // 详细地址
    province: { type: String, default: '' }, // 服务端离线 locateRegion 补全
    city: { type: String, default: '' },
    adcode: { type: Number, default: 0 },
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
  },
  { _id: false },
);

const footprintRecordSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    visitDate: { type: String, required: true }, // YYYY-MM-DD，字符串免时区、可排序
    title: { type: String, required: true },
    people: { type: [String], default: [] },
    description: { type: String, default: '' },
    location: { type: locationSchema, required: true },
    photos: { type: [String], default: [] }, // 裸 OSS URL（上限 3，zod 层约束），读时签名
  },
  { timestamps: true, versionKey: false },
);

footprintRecordSchema.index({ userId: 1, visitDate: -1 });

export type FootprintRecord = mongoose.InferSchemaType<typeof footprintRecordSchema>;

export const FootprintRecordModel =
  models.FootprintRecord ?? model('FootprintRecord', footprintRecordSchema);
