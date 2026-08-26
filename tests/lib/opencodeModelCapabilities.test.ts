import { describe, expect, it } from "vitest";

import type {
  ModelsDevModel,
  ModelsDevResponse,
} from "@/lib/modelsDevPricing";
import {
  applyModelsDevCapabilities,
  buildVariantsForModel,
  findModelsDevEntry,
  injectedEffortsForModel,
  transformModelsDevEntry,
} from "@/lib/opencodeModelCapabilities";
import type { OpenCodeModel } from "@/types";

// 与 models.dev 真实条目同构的 grok-4.6 样本（2026-08 抓取）；
// as 断言：description/knowledge/structured_output 等本就是类型契约外的原始目录字段
const GROK_46 = {
  id: "grok-4.6",
  name: "Grok 4.6",
  description: "xAI's frontier model",
  family: "grok",
  attachment: true,
  reasoning: true,
  reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh"] }],
  tool_call: true,
  structured_output: true,
  temperature: true,
  knowledge: "2026-02-01",
  release_date: "2026-08-12",
  last_updated: "2026-08-12",
  modalities: { input: ["text", "image", "pdf"], output: ["text"] },
  open_weights: false,
  limit: { context: 500000, output: 500000 },
  cost: {
    input: 2,
    output: 6,
    cache_read: 0.5,
    tiers: [
      {
        input: 4,
        output: 12,
        cache_read: 1,
        tier: { type: "context", size: 200000 },
      },
    ],
  },
};

// gpt-5.6-sol 样本：limit 含 input 字段、reasoning_options 含 max 档
const GPT_56_SOL: ModelsDevModel = {
  id: "gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  family: "gpt-sol",
  release_date: "2026-07-09",
  attachment: true,
  reasoning: true,
  temperature: false,
  tool_call: true,
  reasoning_options: [
    {
      type: "effort",
      values: ["none", "low", "medium", "high", "xhigh", "max"],
    },
  ],
  modalities: { input: ["text", "image", "pdf"], output: ["text"] },
  limit: { context: 1050000, input: 922000, output: 128000 },
  cost: { input: 4, output: 20, cache_read: 0.4, cache_write: 5 },
};

describe("injectedEffortsForModel", () => {
  it("复刻 H7：gpt-5 系按发布日期插入 none/minimal/xhigh", () => {
    expect(injectedEffortsForModel("gpt-5.6-sol", "2026-07-09")).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("非 gpt-5 模型按发布日期得到 none/xhigh", () => {
    expect(injectedEffortsForModel("grok-4.6", "2026-08-12")).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("特殊系列只注入单一档位", () => {
    expect(injectedEffortsForModel("gpt-5.6-deep-research")).toEqual(["medium"]);
    expect(injectedEffortsForModel("gpt-5-chat", "2026-07-09")).toEqual(["medium"]);
    expect(injectedEffortsForModel("gpt-5-pro", "2026-07-09")).toEqual(["high"]);
  });

  it("无日期的基础模型为 low/medium/high", () => {
    expect(injectedEffortsForModel("some-model")).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });
});

describe("transformModelsDevEntry", () => {
  it("按 opencode schema 白名单裁剪，丢弃 schema 外字段", () => {
    const out = transformModelsDevEntry(GROK_46);
    expect(Object.keys(out).sort()).toEqual([
      "attachment",
      "cost",
      "family",
      "limit",
      "modalities",
      "name",
      "reasoning",
      "release_date",
      "temperature",
      "tool_call",
    ]);
    expect(out).not.toHaveProperty("description");
    expect(out).not.toHaveProperty("knowledge");
    expect(out).not.toHaveProperty("last_updated");
    expect(out).not.toHaveProperty("open_weights");
    expect(out).not.toHaveProperty("structured_output");
    expect(out).not.toHaveProperty("reasoning_options");
    expect(out).not.toHaveProperty("id");
  });

  it("cost 无 context_over_200k 时从 tiers 转换", () => {
    const out = transformModelsDevEntry(GROK_46);
    expect(out.cost).toEqual({
      input: 2,
      output: 6,
      cache_read: 0.5,
      context_over_200k: { input: 4, output: 12, cache_read: 1 },
    });
  });

  it("cost 已有 context_over_200k 时直接采用", () => {
    const entry: ModelsDevModel = {
      ...GROK_46,
      cost: {
        input: 2,
        output: 6,
        context_over_200k: { input: 9 },
        tiers: [
          { input: 4, output: 12, tier: { type: "context", size: 200000 } },
        ],
      },
    };
    const out = transformModelsDevEntry(entry);
    expect(out.cost).toEqual({
      input: 2,
      output: 6,
      context_over_200k: { input: 9 },
    });
  });

  it("limit 只保留 context/input/output", () => {
    const entry: ModelsDevModel = {
      ...GROK_46,
      limit: { context: 100, input: 50, output: 80 } as ModelsDevModel["limit"],
    };
    expect(transformModelsDevEntry(entry).limit).toEqual({
      context: 100,
      input: 50,
      output: 80,
    });
  });
});

describe("buildVariantsForModel", () => {
  it("@ai-sdk/openai 生成三件套 plain 键并屏蔽注入但不支持的档位", () => {
    const result = buildVariantsForModel(GROK_46, "@ai-sdk/openai", "grok-4.6");
    expect(result).not.toBeNull();
    // grok-4.6 release 2026-08-12 → 注入集 [none, low, medium, high, xhigh]；
    // 官方仅声明 low/medium/high/xhigh，none 被屏蔽
    expect(result?.efforts).toEqual(["low", "medium", "high", "xhigh"]);
    expect(result?.suppressed).toEqual(["none"]);
    expect(Object.keys(result?.variants ?? {})).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "none",
    ]);
    expect(result?.variants.low).toEqual({
      reasoningEffort: "low",
      reasoningSummary: "auto",
      include: ["reasoning.encrypted_content"],
    });
    expect(result?.variants.none).toEqual({ disabled: true });
  });

  it("@ai-sdk/openai-compatible 仅生成 reasoningEffort 并屏蔽注入集内不支持的 max", () => {
    const result = buildVariantsForModel(
      GROK_46,
      "@ai-sdk/openai-compatible",
      "grok-4.6",
    );
    // 注入集 [high, max]：high 在官方档位内不屏蔽，max 不被支持 → disabled 屏蔽
    expect(result?.suppressed).toEqual(["max"]);
    expect(result?.variants.max).toEqual({ disabled: true });
    expect(result?.variants.low).toEqual({ reasoningEffort: "low" });
  });

  it("无 reasoning_options(effort) 时返回 null", () => {
    expect(
      buildVariantsForModel(
        { name: "m" },
        "@ai-sdk/openai",
        "m",
      ),
    ).toBeNull();
  });
});

describe("findModelsDevEntry", () => {
  const catalog: ModelsDevResponse = {
    xai: { models: { "grok-4.6": { name: "Grok via xai" } } },
    openai: { models: { "grok-4.6": { name: "Grok via openai" } } },
    openrouter: { models: { "GROK-4.6": { name: "Grok via openrouter" } } },
  };

  it("按官方源优先级命中", () => {
    const hit = findModelsDevEntry(catalog, "grok-4.6");
    expect(hit?.providerId).toBe("openai");
  });

  it("forcedSource 覆盖优先级", () => {
    const hit = findModelsDevEntry(catalog, "grok-4.6", "xai");
    expect(hit?.providerId).toBe("xai");
  });

  it("官方源未命中时大小写不敏感全表兜底", () => {
    const hit = findModelsDevEntry(catalog, "Grok-4.6-X");
    expect(hit).toBeNull();
    const loose = findModelsDevEntry(
      { openrouter: { models: { "GROK-4.6": { name: "x" } } } },
      "grok-4.6",
    );
    expect(loose?.providerId).toBe("openrouter");
  });
});

describe("applyModelsDevCapabilities", () => {
  const existing: OpenCodeModel = {
    name: "我的显示名",
    limit: { context: 1, output: 2 },
    options: { provider: { order: ["baseten"] } },
    headers: { "X-Custom": "keep" },
    customKey: "keep-me",
    variants: { "01-low": { reasoningEffort: "low" } },
  };

  it("能力字段覆盖；已手填的 limit.context/output 保留；显示名/SDK 选项/人工键保留；旧 variants 被刷新", () => {
    const { model, summary } = applyModelsDevCapabilities(
      existing,
      "@ai-sdk/openai",
      "grok-4.6",
      GROK_46,
    );
    expect(model.name).toBe("我的显示名");
    // 中转站要求特定大小时用户手填的 context/output 不被覆盖
    expect(model.limit).toEqual({ context: 1, output: 2 });
    expect(model.options).toEqual({ provider: { order: ["baseten"] } });
    expect(model.headers).toEqual({ "X-Custom": "keep" });
    expect(model.customKey).toBe("keep-me");
    expect(model.family).toBe("grok");
    expect(model.variants).toHaveProperty("low");
    expect(model.variants).not.toHaveProperty("01-low");
    expect(summary.contextLimit).toBe(1);
    expect(summary.suppressed).toEqual(["none"]);
  });

  it("limit 仅非空字段保留，空缺字段补 models.dev 值", () => {
    const { model } = applyModelsDevCapabilities(
      { name: "", limit: { context: 123456 } },
      "@ai-sdk/openai",
      "gpt-5.6-sol",
      GPT_56_SOL,
    );
    // 用户只填了 context → 保留；output 空缺 → 补官方值
    expect(model.limit).toEqual({ context: 123456, input: 922000, output: 128000 });
  });

  it("models.dev 条目无 limit 时不清除用户已填的 limit", () => {
    const { model, summary } = applyModelsDevCapabilities(
      { name: "", limit: { context: 999, output: 888 } },
      "@ai-sdk/openai",
      "m",
      { name: "M" },
    );
    expect(model.limit).toEqual({ context: 999, output: 888 });
    expect(summary.contextLimit).toBe(999);
  });

  it("用户未填 limit 时整体采用 models.dev 值", () => {
    const { model } = applyModelsDevCapabilities(
      { name: "" },
      "@ai-sdk/openai",
      "grok-4.6",
      GROK_46,
    );
    expect(model.limit).toEqual({ context: 500000, output: 500000 });
  });

  it("显示名为空时填官方名", () => {
    const { model } = applyModelsDevCapabilities(
      { name: "" },
      "@ai-sdk/openai",
      "grok-4.6",
      GROK_46,
    );
    expect(model.name).toBe("Grok 4.6");
  });

  it("无 reasoning_options 时不写 variants 且清除旧 variants", () => {
    const { model } = applyModelsDevCapabilities(
      existing,
      "@ai-sdk/openai",
      "m",
      { name: "M" },
    );
    expect(model).not.toHaveProperty("variants");
  });
});
