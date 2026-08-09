import { describe, expect, it } from "vitest";
import { classifyTaskType } from "./classify.js";
import { computeTotalScore, heuristicScore, sanitizeDimensions } from "./score.js";
import { normalizePromptText, validatePromptText } from "./normalize.js";

describe("normalizePromptText", () => {
  it("去除首尾空白并折叠多余换行", () => {
    expect(normalizePromptText("  写个邮件\n\n\n第二段  \n  ")).toBe("写个邮件\n\n第二段");
  });

  it("保留内部换行与中文", () => {
    expect(normalizePromptText("第一行\n第二行")).toBe("第一行\n第二行");
  });

  it("校验空输入", () => {
    expect(validatePromptText("   \n  ").isValid).toBe(false);
  });

  it("校验超长输入", () => {
    expect(validatePromptText("a".repeat(20_001)).isValid).toBe(false);
  });
});

describe("classifyTaskType", () => {
  const cases: Array<[string, string]> = [
    ["写个邮件", "writing"],
    ["用 React 写一个登录页面", "coding"],
    ["分析一下我们的市场", "analysis"],
    ["帮我制定英语学习计划", "learning"],
    ["把这段话翻译成英文", "translation"],
    ["帮我做一个产品推广方案", "business"],
    ["帮我写一个产品推广方案", "business"],
  ];
  it.each(cases)("识别：%s → %s", (text, expected) => {
    expect(classifyTaskType(text).taskType).toBe(expected);
  });

  it("无命中时返回 general", () => {
    expect(classifyTaskType("你好啊").taskType).toBe("general");
  });

  it("置信度在合理区间", () => {
    const r = classifyTaskType("帮我做一个产品推广方案");
    expect(r.confidence).toBeGreaterThanOrEqual(0);
    expect(r.confidence).toBeLessThanOrEqual(0.95);
  });

  it("study 归属 learning 而非 research（修复 N：不因双归属恒输）", () => {
    expect(classifyTaskType("study 单词记忆").taskType).toBe("learning");
    expect(classifyTaskType("study 单词记忆").taskType).not.toBe("research");
    // 纯英文语境同样归属 learning。
    expect(classifyTaskType("how to study").taskType).toBe("learning");
  });

  it("「编译这段代码」不误判为翻译（修复 O：移除单字『译』）", () => {
    expect(classifyTaskType("编译这段代码").taskType).not.toBe("translation");
    // 真正的翻译请求仍命中 translation。
    expect(classifyTaskType("把这段话翻译成英文").taskType).toBe("translation");
    expect(classifyTaskType("把这句中译英").taskType).toBe("translation");
  });
});

describe("computeTotalScore", () => {
  it("满分", () => {
    const dims: Record<string, number> = {
      objective: 100,
      context: 100,
      audience: 100,
      outputFormat: 100,
      constraints: 100,
      role: 100,
      materials: 100,
      actionability: 100,
    };
    expect(computeTotalScore(dims as never)).toBe(100);
  });

  it("加权计算：一半维度 100，一半 0 → 50", () => {
    const dims: Record<string, number> = {
      objective: 100,
      context: 0,
      audience: 100,
      outputFormat: 0,
      constraints: 100,
      role: 0,
      materials: 100,
      actionability: 0,
    };
    expect(computeTotalScore(dims as never)).toBe(50);
  });

  it("维度分越界时被钳制", () => {
    // context 为 -5，被钳制为 0；其余维度 100 → 加权总分 85（context 权重 15）
    const dims: Record<string, number> = {
      objective: 100,
      context: -5,
      audience: 100,
      outputFormat: 100,
      constraints: 100,
      role: 100,
      materials: 100,
      actionability: 100,
    };
    expect(computeTotalScore(dims as never)).toBe(85);
  });
});

describe("heuristicScore", () => {
  it("空泛请求得分低于结构化请求", () => {
    const vague = heuristicScore("写个东西");
    const rich = heuristicScore(
      "请为面向中小电商商家的 SaaS 库存工具制定 30 天获客方案，预算 2 万，以表格输出渠道、动作、预算、指标",
    );
    expect(rich.total).toBeGreaterThan(vague.total);
  });

  it("缺失项被列出", () => {
    const r = heuristicScore("写个邮件");
    expect(r.missing.length).toBeGreaterThan(0);
  });

  it("总分与维度一致（由 computeTotalScore 得出）", () => {
    const r = heuristicScore("分析一下我们的市场");
    expect(r.total).toBe(computeTotalScore(r.dimensions));
  });

  it("context 维度可满分（修复 P：长度占比满分 40→50）", () => {
    // 修复前 context = 50 + ratio*40，最大值 90，永远差 10 分到满分。
    // 修复后 = 50 + ratio*50，文本 ≥119 字 + 背景词 → 100。
    const rich = heuristicScore(
      "请为面向中小电商商家、我们的公司目前的现状，分析一下市场情况并制定 30 天获客方案，预算 2 万，以表格输出渠道、动作、预算、指标，你是产品经理，根据我们提供的数据、资料、例子，按照不超过 2000 字的约束，给出步骤、计划、清单，并说明如何落地执行。",
    );
    expect(rich.dimensions.context).toBe(100);
    // 修复前同一输入 context 最多 90；修复后 context 满分让总分至少 +1.5（15% 权重）。
    // 注意：audience/role/materials 等维度有产品定义上限，总分不可能到 100——这里只验证
    // context 维度的满分可达（审计确认的核心问题）。
    expect(rich.total).toBeGreaterThan(80);
  });
});

describe("sanitizeDimensions", () => {
  it("补齐缺失字段并钳制越界", () => {
    const out = sanitizeDimensions({ objective: 999 } as never);
    expect(out.objective).toBe(100);
    expect(out.audience).toBe(0);
    expect(Object.keys(out).length).toBe(8);
  });

  it("非数字字段归零", () => {
    const out = sanitizeDimensions({ objective: "abc" } as never);
    expect(out.objective).toBe(0);
  });
});
