/**
 * 业务错误类（借鉴 poetry-quiz-system 约定）
 *
 * Service 层通过 throw AppError 向上层传递业务错误，
 * 路由层 handleServiceError 捕获后统一格式化为标准 API 响应。
 *
 * 用法:
 *   throw new AppError(400, '运动类型不合法');
 *   throw new AppError(409, '活动已结束，不能再上传轨迹点', { code: 'ACTIVITY_FINISHED' });
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
