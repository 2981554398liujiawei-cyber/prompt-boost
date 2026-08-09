/**
 * Provider HTTP 响应 → ProviderError 映射。
 *
 * 优先结合 HTTP 状态码与 Provider 返回的结构化错误字段，不依赖英文错误字符串。
 */
import { ProviderError, type ProviderErrorCode } from "./types.js";

/** 从任意 HTTP 响应中提取供应商错误类型（用于 403 限流/配额判断）。 */
function extractProviderType(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  const err = obj.error;
  if (err && typeof err === "object") {
    const type = (err as Record<string, unknown>).type;
    if (typeof type === "string") return type;
  }
  return null;
}

const RATE_LIMIT_TYPES = new Set([
  "rate_limit_error",
  "insufficient_quota",
  "insufficient_quota_error",
  "request_limit_reached",
]);

/**
 * 将 HTTP 状态码 + 响应体映射为 ProviderError。
 * 返回 null 表示响应是成功类（2xx）。
 */
export function mapProviderResponse(
  type: string,
  status: number,
  bodyText: string,
): ProviderError | null {
  if (status >= 200 && status < 300) return null;

  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    body = null;
  }

  const providerType = extractProviderType(body);
  const isRateLimitType =
    providerType != null && RATE_LIMIT_TYPES.has(providerType.toLowerCase());

  let code: ProviderErrorCode;
  let retryable = false;
  let safeMessage = `Provider 请求失败（HTTP ${status}）`;

  switch (status) {
    case 401:
    case 403:
      // 403 若供应商标记为限流/配额则按相应错误处理。
      if (status === 403 && isRateLimitType) {
        code = providerType === "insufficient_quota" ? "INSUFFICIENT_QUOTA" : "RATE_LIMITED";
        retryable = providerType !== "insufficient_quota";
        safeMessage =
          code === "INSUFFICIENT_QUOTA"
            ? "API 余额不足或额度已用尽"
            : "请求频率过高，请稍后重试";
      } else {
        code = "INVALID_API_KEY";
        retryable = false;
        safeMessage = "API Key 无效或没有权限（请检查 Key 与 Provider 配置）";
      }
      break;
    case 404:
      code = "MODEL_NOT_FOUND";
      retryable = false;
      safeMessage = "模型不存在或接口路径错误";
      break;
    case 429:
      code = "RATE_LIMITED";
      retryable = true;
      safeMessage = "请求频率过高，请稍后重试";
      break;
    case 400:
    case 422:
      code = "INVALID_REQUEST";
      retryable = false;
      safeMessage = "请求参数无效（模型或字段不匹配）";
      break;
    case 500:
    case 502:
    case 503:
      code = "PROVIDER_UNAVAILABLE";
      retryable = true;
      safeMessage = "Provider 服务暂时不可用，请稍后重试";
      break;
    default:
      code = "UNKNOWN";
      retryable = false;
      safeMessage = `Provider 返回未知错误（HTTP ${status}）`;
  }

  return new ProviderError({ code, providerType: type, status, retryable, safeMessage });
}

/** 网络异常 → ProviderError 映射。 */
export function mapNetworkError(type: string, err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  const name = err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : String(err);

  if (
    name === "AbortError" ||
    // Node 的 AbortSignal.timeout() 以 name="TimeoutError" 拒绝（而非 AbortError）。
    name === "TimeoutError" ||
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("aborted due to timeout")
  ) {
    return new ProviderError({
      code: "TIMEOUT",
      providerType: type,
      retryable: true,
      safeMessage: "请求超时，请检查网络或增大超时时间",
      cause: err,
    });
  }

  const isConnectionError =
    /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|network/i.test(message) ||
    (err instanceof TypeError && message === "fetch failed");
  if (isConnectionError) {
    return new ProviderError({
      code: "CONNECTION_FAILED",
      providerType: type,
      retryable: true,
      safeMessage: "无法连接到 Provider（请检查 Base URL 与网络）",
      cause: err,
    });
  }

  return new ProviderError({
    code: "UNKNOWN",
    providerType: type,
    retryable: false,
    safeMessage: "Provider 请求失败",
    cause: err,
  });
}
