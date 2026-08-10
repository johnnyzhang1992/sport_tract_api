import fp from 'fastify-plugin';
import mongoose from 'mongoose';
import { config } from '../config/index.js';

/**
 * Mongoose 连接插件
 * 文档 D1/C：自建 MongoDB，本地/线上实例新建独立库，不容器化
 */
export default fp(
  async (fastify) => {
    await mongoose.connect(config.mongodbUri, {
      serverSelectionTimeoutMS: 5000,
    });
    fastify.log.info(`MongoDB 已连接: ${config.mongodbUri}`);

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
