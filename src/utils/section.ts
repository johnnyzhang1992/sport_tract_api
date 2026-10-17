/**
 * 按段降级：把多个独立子查询的结果各自包成 {ok, data|error}。
 * 首页合并接口用它 —— 合并成一次请求后，「某一段 500 只影响那一段」这条保证必须由服务端继续兑现，
 * 否则会把 3cb2d5e 修掉的「一个接口挂掉、整块卡片消失」原样请回来。
 */
export type SectionResult<T> = { ok: true; data: T } | { ok: false; error: string };

export async function collectSection<T>(fn: () => Promise<T>): Promise<SectionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
