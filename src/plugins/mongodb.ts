import fp from 'fastify-plugin';
import mongoose from 'mongoose';
import { config } from '../config/index.js';
import { ActivityModel } from '../models/activity.model.js';
import { CampaignMemberModel } from '../models/campaign-member.model.js';
import { hasUniqueInProgressIndex, hasUniqueJoinedIndex } from '../utils/guard-index.js';

/**
 * Mongoose 连接插件
 * 文档 D1/C：自建 MongoDB，本地/线上实例新建独立库，不容器化
 */
export default fp(
  async (fastify) => {
    await mongoose.connect(config.mongodbUri, {
      serverSelectionTimeoutMS: 5000,
    });
    // 不打整条 URI：里面含账号密码，落进日志就是凭据泄露
    fastify.log.info(`MongoDB 已连接: ${mongoose.connection.host}/${mongoose.connection.name}`);

    // autoIndex 只异步建索引，建失败（存量重复数据等）仅一条 warning，防线静默消失。
    // 这里显式等建完并核对形状，让"兜底不可用"在启动时就成为一条明确的 error
    try {
      await ActivityModel.createIndexes();
      if (!hasUniqueInProgressIndex(await ActivityModel.collection.indexes())) {
        fastify.log.error(
          '防线缺失：activities 上没有 {userId,status} 的 unique + partial(status=in_progress) 索引，' +
            '同用户并发创建可产生多条进行中轨迹（应用层 findOne 有窗口，E11000→409 也永不触发）',
        );
      }
    } catch (err) {
      fastify.log.error({ err }, 'activities 索引建立失败：同用户多条进行中轨迹的 DB 级兜底不可用，需先收尾存量重复数据');
    }

    // campaignmembers 的 {campaignId,userId} unique + partial(state='joined') 与上同理：
    // autoIndex 静默失败时同一用户可在同一活动留两条 joined，汇总/排行榜按行求和映射 → 同一人算两次/列两次。
    // 同样显式等建完并核对形状，失败只落一条 error，不阻塞启动。
    try {
      await CampaignMemberModel.createIndexes();
      if (!hasUniqueJoinedIndex(await CampaignMemberModel.collection.indexes())) {
        fastify.log.error(
          '防线缺失：campaignmembers 上没有 {campaignId,userId} 的 unique + partial(state=joined) 索引，' +
            '同一用户可在同一活动留下多条 joined 行（详情汇总/排行榜会把同一人算两次），E11000→409 也永不触发',
        );
      }
    } catch (err) {
      fastify.log.error({ err }, 'campaignmembers 索引建立失败：重复 joined 的 DB 级兜底不可用，需先收尾存量重复行');
    }

    // 连接断开后自动重连（mongoose 默认行为），记录状态变化
    mongoose.connection.on('disconnected', () => {
      fastify.log.warn('MongoDB 连接断开');
    });
    mongoose.connection.on('reconnected', () => {
      fastify.log.info('MongoDB 已重连');
    });

    // 应用关闭时断开连接
    fastify.addHook('onClose', async () => {
      await mongoose.disconnect();
    });
  },
  { name: 'mongodb' },
);
