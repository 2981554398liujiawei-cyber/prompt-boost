/**
 * Content Script ↔ Background 消息封装。
 */
import {
  MessageType,
  type BoostAnalyzeMessage,
  type BoostAnalyzeReply,
  type BoostEnhanceMessage,
  type BoostEnhanceReply,
} from "@prompt-boost/shared";

/** 发送增强请求，返回标准化结果。 */
export function sendEnhanceRequest(
  message: BoostEnhanceMessage,
): Promise<BoostEnhanceReply> {
  return chrome.runtime.sendMessage({ type: MessageType.BoostEnhance, ...message });
}

/** 发送评分/分析请求。 */
export function sendAnalyzeRequest(message: BoostAnalyzeMessage): Promise<BoostAnalyzeReply> {
  return chrome.runtime.sendMessage({ type: MessageType.BoostAnalyze, ...message });
}
