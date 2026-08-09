import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  SCORE_WEIGHTS,
  zEnhancePromptRequest,
  zEnhancePromptResponse,
  zExtensionSettings,
  zScore,
} from "./index.js";

describe("constants", () => {
  it("评分权重总和为 100", () => {
    const total = Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBe(100);
  });

  it("默认设置为 deep / smart / auto", () => {
    expect(DEFAULT_SETTINGS.enhanceLevel).toBe("deep");
    expect(DEFAULT_SETTINGS.clarificationMode).toBe("smart");
    expect(DEFAULT_SETTINGS.taskType).toBe("auto");
  });
});

describe("schemas", () => {
  it("zScore 接受 0..100 整数", () => {
    expect(zScore.parse(0)).toBe(0);
    expect(zScore.parse(100)).toBe(100);
    expect(() => zScore.parse(101)).toThrow();
    expect(() => zScore.parse(-1)).toThrow();
    expect(() => zScore.parse(64.5)).toThrow();
  });

  it("zEnhancePromptRequest 校验合法请求", () => {
    const req = zEnhancePromptRequest.parse({
      originalText: "帮我写一个产品推广方案",
      taskType: "auto",
      enhanceLevel: "deep",
      clarificationMode: "smart",
    });
    expect(req.enhanceLevel).toBe("deep");
  });

  it("zEnhancePromptRequest 拒绝空输入", () => {
    expect(() =>
      zEnhancePromptRequest.parse({ originalText: "", taskType: "auto" }),
    ).toThrow();
  });

  it("zEnhancePromptRequest 拒绝超长输入", () => {
    expect(() =>
      zEnhancePromptRequest.parse({ originalText: "a".repeat(20_001) }),
    ).toThrow();
  });

  it("zEnhancePromptResponse 校验合法响应", () => {
    const res = zEnhancePromptResponse.parse({
      enhancedText: "优化后的 Prompt",
      analysis: {
        detectedTaskType: "business",
        confidence: 0.8,
        scoreDimensions: {
          objective: 80,
          context: 50,
          audience: 0,
          outputFormat: 60,
          constraints: 40,
          role: 30,
          materials: 20,
          actionability: 70,
        },
        missingInformation: ["目标用户"],
        criticalMissingInformation: [],
        suggestions: ["补充目标用户"],
        totalScore: 60,
        scoreSource: "llm",
        clarificationRequired: false,
        clarificationQuestions: [],
      },
      assumptions: ["假设……"],
      provider: "openai",
      model: "gpt-4o-mini",
    });
    expect(res.enhancedText).toContain("优化");
  });

  it("zEnhancePromptResponse 拒绝非法任务类型", () => {
    expect(() =>
      zEnhancePromptResponse.parse({
        enhancedText: "x",
        analysis: {
          detectedTaskType: "nonexistent",
          confidence: 0.5,
          scoreDimensions: {
            objective: 1,
            context: 1,
            audience: 1,
            outputFormat: 1,
            constraints: 1,
            role: 1,
            materials: 1,
            actionability: 1,
          },
          missingInformation: [],
          criticalMissingInformation: [],
          suggestions: [],
          clarificationRequired: false,
          clarificationQuestions: [],
        },
        assumptions: [],
        provider: "openai",
        model: "gpt-4o-mini",
      }),
    ).toThrow();
  });

  it("zExtensionSettings 允许缺 providers（首次运行/旧版本迁移），默认空数组", () => {
    // 回归：providers 无 default 时 parse({}) 抛 [providers] Required，
    // 导致 getExtensionSettings() 抛错、后台全部消息处理挂起、连接测试永久卡住。
    const parsed = zExtensionSettings.parse({});
    expect(parsed.providers).toEqual([]);
    expect(parsed.localAgentUrl).toContain("127.0.0.1:8787");
    expect(parsed.defaultEnhanceLevel).toBe("deep");
    expect(parsed.defaultClarificationMode).toBe("smart");
    expect(parsed.defaultTaskType).toBe("auto");
    expect(parsed.outputLanguage).toBe("auto");
  });

  it("zExtensionSettings 保留已有 providers 与令牌", () => {
    const parsed = zExtensionSettings.parse({
      providers: [
        {
          id: "p1",
          name: "我的 Provider",
          type: "openai-compatible",
          baseUrl: "https://api.example.com/v1",
          model: "gpt-4o-mini",
          enabled: true,
        },
      ],
      localAgentToken: "token-abc",
      localAgentUrl: "http://127.0.0.1:8787",
    });
    expect(parsed.providers).toHaveLength(1);
    expect(parsed.providers[0].name).toBe("我的 Provider");
    expect(parsed.localAgentToken).toBe("token-abc");
  });
});
