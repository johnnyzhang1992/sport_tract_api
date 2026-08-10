/**
 * 统一 API 响应格式：{ success, code, message, data }
 * （借鉴 poetry-quiz-system 约定，前端 api.js 按此解析）
 */

export interface ApiResponse<T = unknown> {
  success: boolean;
  code: number;
  message: string;
  data: T | null;
}

export function success<T>(data: T, message = 'success'): ApiResponse<T> {
  return { success: true, code: 200, message, data };
}

export function error<T = null>(
  message: string,
  code = 500,
  extra?: Record<string, unknown>,
): ApiResponse<T> {
  return { success: false, code, message, data: (extra as T) ?? null };
}

export function badRequest(message: string): ApiResponse<null> {
  return error(message, 400);
}

export function unauthorized(message = '未授权，请先登录'): ApiResponse<null> {
  return error(message, 401);
}

export function forbidden(message = '禁止访问'): ApiResponse<null> {
  return error(message, 403);
}

export function notFound(message = '资源不存在'): ApiResponse<null> {
  return error(message, 404);
}
