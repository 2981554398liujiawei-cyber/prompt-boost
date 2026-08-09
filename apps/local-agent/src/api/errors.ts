/**
 * 统一错误码与错误响应构造。
 * 响应体满足 Shared 的 zErrorResponse schema。
 */
import { z, ZodError } from "zod";
import type { ErrorResponse } from "@prompt-boost/shared";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  toResponse(): ErrorResponse {
    return { error: { code: this.code, message: this.message } };
  }
}

export const Err = {
  unauthorized: () => new ApiError(401, "unauthorized", "未授权：缺少或无效的本地认证令牌"),
  badRequest: (message: string) => new ApiError(400, "bad_request", message),
  notFound: () => new ApiError(404, "not_found", "接口不存在"),
  notImplemented: () => new ApiError(501, "not_implemented", "该接口将在后续阶段实现"),
  internal: () => new ApiError(500, "internal", "本地服务内部错误"),
} as const;

/** 将 Zod 解析错误转换为标准错误响应。 */
export function zodErrorResponse(err: ZodError): ErrorResponse {
  const first = err.issues[0];
  const message = first
    ? `${first.path.join(".") || "body"}: ${first.message}`
    : "请求参数无效";
  return { error: { code: "validation", message } };
}

/** 任意异常 → 标准错误响应（不泄露堆栈）。 */
export function toErrorResponse(err: unknown): ErrorResponse {
  if (err instanceof ApiError) return err.toResponse();
  if (err instanceof ZodError) return zodErrorResponse(err);
  return { error: { code: "internal", message: "本地服务内部错误" } };
}

/** 校验函数：传入任意 unknown，使用 zod 校验并返回类型化结果。 */
export function parseOrThrow<T>(schema: z.ZodType<T>, data: unknown): T {
  return schema.parse(data);
}
