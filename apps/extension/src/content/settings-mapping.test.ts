import { describe, expect, it } from "vitest";
import { mapBoostSettingsPatch } from "./settings-mapping.js";

describe("mapBoostSettingsPatch", () => {
  it("把菜单字段映射为扩展存储字段，避免旧默认值覆盖选择", () => {
    expect(
      mapBoostSettingsPatch({
        taskType: "coding",
        enhanceLevel: "expert",
        clarificationMode: "off",
        outputLanguage: "zh-CN",
      }),
    ).toEqual({
      defaultTaskType: "coding",
      defaultEnhanceLevel: "expert",
      defaultClarificationMode: "off",
      outputLanguage: "zh-CN",
    });
  });

  it("局部更新只输出对应存储字段，不写入裸 enhanceLevel", () => {
    const mapped = mapBoostSettingsPatch({ enhanceLevel: "deep" });

    expect(mapped).toEqual({ defaultEnhanceLevel: "deep" });
    expect(mapped).not.toHaveProperty("enhanceLevel");
  });
});
