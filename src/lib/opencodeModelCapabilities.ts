import type { OpenCodeModel } from "@/types";
import type {
  ModelsDevCost,
  ModelsDevModel,
  ModelsDevResponse,
} from "@/lib/modelsDevPricing";

// opencode 对 provider.models.<id> 执行 additionalProperties: false 严格校验，
// 超出白名单的字段（description、reasoning_options 等）会导致 opencode 拒绝加载配置。
// 机制结论来源：https://github.com/tttrove/opencode-model-fetch docs/variant-mechanism.md
export const OPENCODE_MODEL_SCHEMA_ALLOWED_KEYS = [
  "id",
  "name",
  "family",
  "release_date",
  "attachment",
  "reasoning",
  "temperature",
  "tool_call",
  "interleaved",
  "cost",
  "limit",
  "modalities",
  "experimental",
  "status",
  "provider",
  "options",
  "headers",
  "variants",
] as const;

// 本功能会写入/刷新的能力字段；name/options/headers 与人工 extra 键不在其列
const CAPABILITY_KEYS = [
  "family",
  "release_date",
  "attachment",
  "reasoning",
  "temperature",
  "tool_call",
  "modalities",
  "limit",
  "cost",
  "variants",
] as const;

// 官方源优先级：命中即用，避免抓到聚合网关的转述条目
export const MODELS_DEV_SOURCE_PRIORITY = [
  "openai",
  "xai",
  "anthropic",
  "google",
  "google-vertex",
  "deepseek",
  "moonshotai",
  "zhipuai",
  "qwen",
  "minimax",
  "mistral",
  "meta",
  "amazon-bedrock",
  "azure",
] as const;

// @ai-sdk/openai 系（Responses 路径）会按模型 id 与发布日期自动注入默认推理档位
// （none/low/medium/high/xhigh），生成的 variants 需与注入对象同构（三件套）才能
// 零能力损失地按「同名覆盖」语义替换注入项。
const RESPONSES_TRIO_NPM = new Set([
  "@ai-sdk/openai",
  "@ai-sdk/azure",
  "@ai-sdk/amazon-bedrock/mantle",
]);
// @ai-sdk/openai-compatible 仅注入 { reasoningEffort }，且只有 high/max 两档。
const OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible";

// 注入对象里的 include 常量（Responses 推理续传）
const VARIANT_INCLUDE = ["reasoning.encrypted_content"];

const DATE_NONE = "2025-11-13";
const DATE_XHIGH = "2025-12-04";
const GPT5_RE = /(?:^|\/)gpt-5(?:[.-]|$)/;
const GPT5_CHAT_RE = /(?:^|\/)gpt-5[.-]chat(?:[.-]|$)/;
const GPT5_PRO_RE = /(?:^|\/)gpt-5[.-]?pro(?:[.-]|$)/;

export interface ModelsDevEntryHit {
  providerId: string;
  entry: ModelsDevModel;
}

export interface ModelVariantsResult {
  variants: Record<string, Record<string, unknown>>;
  /** 官方声明支持的推理档位（生成 plain 键 variants 的依据） */
  efforts: string[];
  /** 被写入 {"disabled": true} 屏蔽的注入档位 */
  suppressed: string[];
}

export interface CapabilityFillSummary {
  efforts: string[];
  suppressed: string[];
  contextLimit: number | null;
}

export interface CapabilityFillResult {
  model: OpenCodeModel;
  summary: CapabilityFillSummary;
}

/** 在 models.dev 嵌套目录中查找模型：官方源优先级命中，未命中时大小写不敏感全表兜底。 */
export function findModelsDevEntry(
  catalog: ModelsDevResponse,
  modelId: string,
  forcedSource?: string,
): ModelsDevEntryHit | null {
  const sources = forcedSource ? [forcedSource] : MODELS_DEV_SOURCE_PRIORITY;
  for (const providerId of sources) {
    const entry = catalog[providerId]?.models?.[modelId];
    if (entry && typeof entry === "object") return { providerId, entry };
  }

  const target = modelId.toLowerCase();
  for (const [providerId, provider] of Object.entries(catalog)) {
    for (const [key, entry] of Object.entries(provider?.models ?? {})) {
      if (key.toLowerCase() === target && entry && typeof entry === "object") {
        return { providerId, entry };
      }
    }
  }
  return null;
}

/**
 * 复刻 opencode 对 @ai-sdk/openai 系（Responses 路径）的默认档位注入规则：
 * deep-research → [medium]；gpt-5-chat → [medium]；gpt-5-pro → [high]；
 * 其余基础集 [low, medium, high]，gpt-5* 头插 minimal，
 * release_date ≥ 2025-11-13 头插 none，≥ 2025-12-04 追加 xhigh（注入集不含 max）。
 */
export function injectedEffortsForModel(
  modelId: string,
  releaseDate?: string,
): string[] {
  const q = modelId.toLowerCase();
  if (q.includes("deep-research")) return ["medium"];
  if (GPT5_CHAT_RE.test(q)) return ["medium"];
  if (GPT5_PRO_RE.test(q)) return ["high"];
  const efforts = ["low", "medium", "high"];
  if (GPT5_RE.test(q)) efforts.unshift("minimal");
  if (releaseDate && releaseDate >= DATE_NONE) efforts.unshift("none");
  if (releaseDate && releaseDate >= DATE_XHIGH) efforts.push("xhigh");
  return efforts;
}

/** 按 npm 返回会被 opencode 自动注入的推理档位；注入行为未知时返回 null（不屏蔽）。 */
function injectedEffortsForNpm(
  npm: string,
  modelId: string,
  releaseDate?: string,
): string[] | null {
  if (RESPONSES_TRIO_NPM.has(npm)) {
    return injectedEffortsForModel(modelId, releaseDate);
  }
  if (npm === OPENAI_COMPATIBLE_NPM) return ["high", "max"];
  return null;
}

/** @ai-sdk/openai 系与注入对象同构（三件套）；其余 SDK 仅 reasoningEffort。 */
function variantObject(effort: string, npm: string): Record<string, unknown> {
  if (RESPONSES_TRIO_NPM.has(npm)) {
    return {
      reasoningEffort: effort,
      reasoningSummary: "auto",
      include: [...VARIANT_INCLUDE],
    };
  }
  return { reasoningEffort: effort };
}

/**
 * 从 reasoning_options(type=effort) 生成全量 variants（plain 键：与注入键同名覆盖），
 * 并对「会被注入、但官方未声明支持」的档位写入 {"disabled": true} 屏蔽。
 */
export function buildVariantsForModel(
  entry: ModelsDevModel,
  npm: string,
  modelId: string,
): ModelVariantsResult | null {
  const efforts: string[] = [];
  for (const option of entry.reasoning_options ?? []) {
    if (option?.type !== "effort") continue;
    for (const value of option.values ?? []) {
      if (!efforts.includes(value)) efforts.push(value);
    }
  }
  if (efforts.length === 0) return null;

  const variants: Record<string, Record<string, unknown>> = {};
  for (const effort of efforts) {
    variants[effort] = variantObject(effort, npm);
  }

  const suppressed: string[] = [];
  const injected = injectedEffortsForNpm(npm, modelId, entry.release_date);
  for (const effort of injected ?? []) {
    if (!efforts.includes(effort) && !(effort in variants)) {
      variants[effort] = { disabled: true };
      suppressed.push(effort);
    }
  }
  return { variants, efforts, suppressed };
}

const COST_KEYS = ["input", "output", "cache_read", "cache_write"] as const;

function pickCostNumbers(source: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (source && typeof source === "object") {
    for (const key of COST_KEYS) {
      const value = (source as Record<string, unknown>)[key];
      if (typeof value === "number") out[key] = value;
    }
  }
  return out;
}

// models.dev 的 cost.tiers 数组不可写入 opencode 配置，需转换为 context_over_200k
function resolveContextOver200k(
  cost: ModelsDevCost,
): Record<string, number> | null {
  const direct = pickCostNumbers(cost.context_over_200k);
  if (Object.keys(direct).length > 0) return direct;
  for (const tier of cost.tiers ?? []) {
    if (tier?.tier?.type !== "context") continue;
    const converted = pickCostNumbers(tier);
    if (Object.keys(converted).length > 0) return converted;
  }
  return null;
}

/** 按 opencode schema 白名单裁剪 models.dev 条目，丢弃一切 schema 外字段。 */
export function transformModelsDevEntry(
  entry: ModelsDevModel,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  const putString = (key: string, value: unknown) => {
    if (typeof value === "string" && value !== "") out[key] = value;
  };
  const putBoolean = (key: string, value: unknown) => {
    if (typeof value === "boolean") out[key] = value;
  };

  putString("name", entry.name);
  putString("family", entry.family);
  putString("release_date", entry.release_date);
  putBoolean("attachment", entry.attachment);
  putBoolean("reasoning", entry.reasoning);
  putBoolean("temperature", entry.temperature);
  putBoolean("tool_call", entry.tool_call);

  if (entry.modalities && typeof entry.modalities === "object") {
    out.modalities = entry.modalities;
  }

  const limit = entry.limit;
  if (limit && typeof limit === "object") {
    const next: Record<string, number> = {};
    for (const key of ["context", "input", "output"] as const) {
      const value = limit[key];
      if (typeof value === "number") next[key] = value;
    }
    if (Object.keys(next).length > 0) out.limit = next;
  }

  const cost = entry.cost;
  if (cost && typeof cost === "object") {
    const next: Record<string, number | Record<string, number>> =
      pickCostNumbers(cost);
    const over200k = resolveContextOver200k(cost);
    if (over200k) next.context_over_200k = over200k;
    if (Object.keys(next).length > 0) out.cost = next;
  }

  return out;
}

/**
 * 把 models.dev 条目的能力数据合并进现有模型配置：
 * - 能力字段（cost/modalities/variants 等）以 models.dev 为准覆盖；
 * - limit.context / limit.output 用户已手填时保留（中转站常要求特定的
 *   上下文/输出大小），缺失的字段才采用 models.dev 值；limit.input 不在
 *   表单中暴露，始终以 models.dev 为准；
 * - 显示名非空则保留人工输入，为空时填官方名；
 * - options/headers 与白名单外的人工自定义键原样保留；
 * - 不写入 id（模型键名即 id，避免改键名后失同步）。
 */
export function applyModelsDevCapabilities(
  existing: OpenCodeModel,
  npm: string,
  modelId: string,
  entry: ModelsDevModel,
): CapabilityFillResult {
  const next: Record<string, unknown> = { ...existing };
  for (const key of CAPABILITY_KEYS) delete next[key];

  const capabilities = transformModelsDevEntry(entry);
  const existingLimit =
    existing.limit && typeof existing.limit === "object"
      ? (existing.limit as { context?: number; output?: number })
      : {};
  const devLimit = capabilities.limit as Record<string, number> | undefined;
  const mergedLimit: Record<string, number> = { ...(devLimit ?? {}) };
  if (typeof existingLimit.context === "number") {
    mergedLimit.context = existingLimit.context;
  }
  if (typeof existingLimit.output === "number") {
    mergedLimit.output = existingLimit.output;
  }
  if (Object.keys(mergedLimit).length > 0) {
    capabilities.limit = mergedLimit;
  } else {
    delete capabilities.limit;
  }
  Object.assign(next, capabilities);

  const variantsResult = buildVariantsForModel(entry, npm, modelId);
  if (variantsResult) {
    next.variants = variantsResult.variants;
  }

  if (typeof existing.name === "string" && existing.name.trim() !== "") {
    next.name = existing.name;
  }

  const limit = next.limit as { context?: number } | undefined;
  return {
    model: next as OpenCodeModel,
    summary: {
      efforts: variantsResult?.efforts ?? [],
      suppressed: variantsResult?.suppressed ?? [],
      contextLimit: typeof limit?.context === "number" ? limit.context : null,
    },
  };
}
