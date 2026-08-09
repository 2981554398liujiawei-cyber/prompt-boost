/** content script 工具函数。 */

/** 生成唯一请求 ID（优先原生 crypto.randomUUID，回退随机串）。 */
export function randomUUID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 由八维度分数聚合总分（与本地服务 computeTotalScore 语义一致：加权平均）。 */
export function aggregateScore(dimensions: Record<string, number>): number {
  const values = Object.values(dimensions);
  if (values.length === 0) return 0;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}
