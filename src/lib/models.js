// Every model and provider the tracker's research runs on, in one place: names for labels, API
// prices for working out a run's cost (src/lib/model-cost.js), subscription plans and peak hours.
// A run records its model as "provider/model", sometimes with a reasoning variant after "#"
// ("opencode-go/deepseek-v4.1-flash#max"); the variant changes neither the model nor its price.
//
// To add a model, or a provider for one: its prices go under MODELS[model].providers[provider],
// the two halves of the id the worker records, and a new provider's name into PROVIDER_NAMES.
// Prices are USD per million tokens; reasoning is billed as output.

// OpenCode Go charges double in these hours (https://opencode.ai/v2/docs/console/go):
// weekdays (Monday 1 … Friday 5), UTC hours [from, to)
const OPENCODE_GO_PEAK = { days: [1, 2, 3, 4, 5], hours: [[1, 4], [6, 10]] };

// how the providers' ids in a run's model ("swancloud/…") are shown
export const PROVIDER_NAMES = { openai: "OpenAI", xai: "xAI", swancloud: "Swancloud", "opencode-go": "OpenCode Go", muse: "Muse" };

// the providers whose subscription is the one configured on the server (RESEARCH_PLAN_USD and
// RESEARCH_PLAN_ALLOWANCE_USD: OpenCode Go, $10 a month); a model there without a `planMultiplier`
// of its own takes that plan's ratio. Every other provider without a multiplier is paid as used.
export const CONFIGURED_PLAN_PROVIDERS = ["opencode-go"];

// what a provider's subscription costs a month, in USD, where it is known: a model's
// `planMultiplier` then reads as "$10 buys $60" of API usage
export const PLAN_PRICES = { "opencode-go": 10 };

// OpenCode Go's peak hours, for describing them: "weekdays 01:00–04:00 and 06:00–10:00 UTC"
export const describePeak = (peak) => `weekdays ${peak.hours.map(([a, b]) => `${String(a).padStart(2, "0")}:00–${String(b).padStart(2, "0")}:00`).join(" and ")} UTC`;

// Each model once, with its price at every provider that offers it. Prices: `input`, `output`;
// `cached` (cache reads) and `cacheWrite` fall back to `input` where no rate of their own was
// supplied; `peak` with `peakInput`/`peakOutput`/`peakCached` for hours that cost more;
// `longContext` for requests above a model's input-token threshold;
// `planMultiplier` divides the API price into what a run takes of a subscription.
//
// `api` is the maker's own list price on its first-party API (same fields), whoever serves the
// model: what the tokens would cost bought directly, so models on different providers and plans
// can be compared on one basis. `null` where the model has no paid price (a free preview).
// `source` says where it was read and when; `unconfirmed` marks a price only third parties report.
export const MODELS = {
  "gpt-6.1-terra": {
    name: "GPT-6.1 Terra", by: "OpenAI",
    // https://developers.openai.com/api/docs/pricing, standard tier, read November 2026: up to
    // 272K input tokens; cache writes at the 30-minute retention price
    api: { input: 1.00, output: 5.00, cached: 0.05, cacheWrite: 1.25, longContext: { threshold: 272_000, input: 2.00, output: 7.50, cached: 0.10 }, source: "developers.openai.com/api/docs/pricing, Nov 2026" },
    providers: {
      openai: { input: 1.00, output: 5.00, cached: 0.05, cacheWrite: 1.25 },
    },
  },
  "gpt-6-luna": {
    name: "GPT-6 Luna", by: "OpenAI",
    api: { input: 0.10, output: 0.50, cached: 0.01, cacheWrite: 0.125, longContext: { threshold: 272_000, input: 0.20, output: 0.75, cached: 0.02 }, source: "developers.openai.com/api/docs/pricing, Nov 2026" },
    providers: {
      openai: { input: 0.10, output: 0.50, cached: 0.01, cacheWrite: 0.125 },
    },
  },
  "grok-4.7": {
    name: "Grok 4.7", by: "xAI",
    // https://docs.x.ai/docs/pricing, read November 2026: a request whose prompt reaches 200K
    // tokens is billed at the higher rate for all its tokens. "grok-4.7-free" on Swancloud is
    // taken to be this model on a free promotion.
    api: { input: 2.00, output: 6.00, cached: 0.50, longContext: { threshold: 200_000, input: 4.00, output: 12.00, cached: 1.00 }, source: "docs.x.ai/docs/pricing, Nov 2026" },
    providers: {
      xai: { input: 2.00, output: 6.00, cached: 0.50 },
    },
  },
  "grok-4.3": {
    name: "Grok 4.3", by: "xAI",
    api: { input: 1.25, output: 2.50, cached: 0.20, longContext: { threshold: 200_000, input: 2.50, output: 5.00, cached: 0.40 }, source: "docs.x.ai/docs/pricing, Nov 2026" },
    providers: {
      xai: { input: 1.25, output: 2.50, cached: 0.20 },
    },
  },
  "muse-spark-1.3-contributor": {
    name: "Muse Spark 1.3 Contributor", by: "Meta",
    // Meta's contributor endpoint (Meta may train on the traffic); the standard endpoint is
    // $1.25 / $4.25, cached $0.15 (dev.meta.ai pricing, as reported by third parties)
    api: { input: 0.10, output: 0.20, cached: 0.002, source: "dev.meta.ai contributor rate, as reported Sep 2026", unconfirmed: true },
    providers: {
      // operator-supplied rates; a 15× subscription on Swancloud, 6× on OpenCode Go ($10 buys $60)
      swancloud: { input: 0.100, output: 0.200, cached: 0.002, planMultiplier: 15 },
      "opencode-go": { input: 0.10, output: 0.20, cached: 0.002, planMultiplier: 6 },
    },
  },
  "muse-ember-1.0": {
    name: "Muse Ember", by: "Meta",
    api: { input: 0.10, output: 0.50, cached: 0.004, longContext: { threshold: 200_000, input: 0.30, output: 1.50, cached: 0.012 }, source: "dev.meta.ai/docs/pricing-rate-limits#muse-ember" },
    providers: {
      // API value of Muse Code usage: https://dev.meta.ai/docs/pricing-rate-limits#muse-ember
      muse: { input: 0.10, output: 0.50, cached: 0.004, longContext: { threshold: 200_000, input: 0.30, output: 1.50, cached: 0.012 } },
    },
  },
  // run on Meta's own Muse agent (RESEARCH_AGENTS "muse@muse-spark-1.3"), always in contributor
  // mode: priced as Muse Spark 1.3 Contributor elsewhere; no plan ratio known yet
  "muse-spark-1.3": {
    name: "Muse Spark 1.3 Contributor", by: "Meta",
    api: { input: 0.10, output: 0.20, cached: 0.002, source: "dev.meta.ai contributor rate, as reported Sep 2026", unconfirmed: true },
    providers: {
      muse: { input: 0.10, output: 0.20, cached: 0.002 },
    },
  },
  "claude-haiku-5.5": {
    name: "Claude Haiku 5.5", by: "Anthropic",
    // Anthropic's own rates (https://claude.com/pricing) for prompts up to 100,000 tokens: cache
    // hits $0.01, 5-minute cache writes $0.125. Longer prompts cost five times as much, which the
    // recorded tokens cannot tell apart, so this is the lower bound.
    api: { input: 0.10, output: 0.50, cached: 0.01, cacheWrite: 0.125, source: "claude.com/pricing, Nov 2026 (prompts up to 100K tokens)" },
    providers: {
      swancloud: { input: 0.100, output: 0.500, cached: 0.01, cacheWrite: 0.125, planMultiplier: 15 },
    },
  },
  "deepseek-v4.1-flash": {
    name: "DeepSeek V4.1 Flash", by: "DeepSeek",
    // DeepSeek's off-peak rates (https://api-docs.deepseek.com/quick_start/pricing); its peak hours
    // cost double
    api: { input: 0.15, output: 0.60, cached: 0.003, source: "api-docs.deepseek.com, off-peak, Nov 2026" },
    providers: {
      // DeepSeek's own off-peak rates (https://api-docs.deepseek.com/quick_start/pricing), cache
      // hits included; Swancloud has no peak hours
      swancloud: { input: 0.150, output: 0.6, cached: 0.003, planMultiplier: 15 },
      // $10 of OpenCode Go buys $100 of DeepSeek at these prices
      "opencode-go": { input: 0.15, output: 0.6, cached: 0.003, peak: OPENCODE_GO_PEAK, peakInput: 0.3, peakOutput: 1.2, peakCached: 0.006, planMultiplier: 10 },
    },
  },
  "deepseek-v4-flash": {
    name: "DeepSeek V4 Flash", by: "DeepSeek",
    // retired: DeepSeek serves the name with V4.1 Flash (DeepSeek-V4.1-Flash-1017) and bills it at
    // the Flash price (api-docs.deepseek.com, November 2026)
    api: { input: 0.15, output: 0.60, cached: 0.003, source: "api-docs.deepseek.com: served and billed as V4.1 Flash, Nov 2026" },
    providers: {},
  },
  "glm-5.3-flash": {
    name: "GLM-5.3 Flash", by: "Z.ai",
    api: { input: 0.15, output: 0.50, cached: 0.03, source: "docs.z.ai, as reported Oct 2026", unconfirmed: true },
    providers: {},
  },
  "minimax-m3.1-flash": {
    name: "MiniMax M3.1 Flash", by: "MiniMax",
    api: { input: 0.15, output: 0.60, cached: 0.015, source: "MiniMax pay-as-you-go, as reported Oct 2026", unconfirmed: true },
    providers: {},
  },
  "hy4-flash": {
    name: "Hy4 Flash", by: "Tencent",
    // Tencent Cloud's list price; "hy4-flash-free" on OpenCode Go is a free promotion of it
    api: { input: 0.070, output: 0.281, cached: 0.003, source: "Tencent Cloud price list, Nov 2026", unconfirmed: true },
    providers: {},
  },
  "ling-3.2-flash": {
    name: "Ling 3.2 Flash", by: "inclusionAI",
    // free at launch; the price after the promotion is only reported by third parties
    api: { input: 0.30, output: 0.90, source: "post-launch price as reported by third parties, Nov 2026", unconfirmed: true },
    providers: {},
  },
  "nemotron-3.5-super-vl-120b-a12b": {
    name: "Nemotron 3.5 Super VL", by: "NVIDIA",
    // open weights: NVIDIA publishes no paid rate of its own; this is the most cited host rate
    api: { input: 0.15, output: 0.50, source: "open weights; most cited host rate, Nov 2026", unconfirmed: true },
    providers: {},
  },
  "nemotron-3.5-lightning-30b-a3b": {
    name: "Nemotron 3.5 Lightning", by: "NVIDIA",
    api: { input: 0.05, output: 0.20, source: "open weights; build.nvidia.com rate as reported Aug 2026", unconfirmed: true },
    providers: {},
  },
  "laguna-xs-2.1": {
    name: "Laguna XS 2.1", by: "Poolside",
    api: { input: 0.10, output: 0.20, source: "Poolside list price, as reported Nov 2026", unconfirmed: true },
    providers: {},
  },
  // free previews on OpenCode Go whose maker and paid price are not published
  beam: { name: "Beam", by: "unknown (OpenCode Go preview)", api: null, providers: {} },
  "iceman-contributor": { name: "Iceman Contributor", by: "unknown (OpenCode Go preview)", api: null, providers: {} },
};

// The model a recorded name stands for, as a key of MODELS, or "" when it is not there:
// "nvidia/minimaxai/minimax-m3.1-flash#thinking" → "minimax-m3.1-flash",
// "openrouter/inclusionai/ling-3.2-flash:free" → "ling-3.2-flash", "grok-4.7-free" → "grok-4.7".
// The maker's prefix and a free-promotion suffix are dropped.
export function standardModel(id) {
  const name = String(id || "").split("#")[0].split("/").pop().replace(/:free$/, "");
  if (MODELS[name]) return name;
  const paid = name.replace(/-free$/, "");
  return MODELS[paid] ? paid : "";
}

// the maker's list price for a recorded model ("provider/model#effort" or a bare name), with the
// model's name; null when the model is unknown or has no paid price
export function apiPrice(id) {
  const key = standardModel(id), m = MODELS[key];
  return m?.api ? { id: key, name: m.name, by: m.by, ...m.api } : null;
}

// "opencode-go/deepseek-v4.1-flash#max" → "opencode-go/deepseek-v4.1-flash"
export const baseModel = (model) => String(model || "").split("#")[0];

// "provider/model#variant" → its parts; `name` is "Not recorded" when there is no model
export function modelParts(id) {
  const [path, effort = ""] = String(id || "").split("#");
  const slash = path.indexOf("/");
  return { provider: slash > 0 ? path.slice(0, slash) : "", name: slash > 0 ? path.slice(slash + 1) : path || "Not recorded", effort };
}

// "provider/model" → the model with that provider's prices, or undefined when it has none
export function modelInfo(model) {
  const id = baseModel(model), { provider, name } = modelParts(id);
  const m = MODELS[name], price = m?.providers[provider];
  return price ? { id, name: m.name, by: m.by, provider, providerName: PROVIDER_NAMES[provider] ?? provider, ...price } : undefined;
}

// every "provider/model" with a price, for listings
export const MODEL_IDS = Object.entries(MODELS).flatMap(([name, m]) => Object.keys(m.providers).map((p) => `${p}/${name}`));

// "Claude Haiku 5.5 · Swancloud", with a reasoning variant after it ("… · max"); a model without
// an entry shows its id, and none "Not configured"
export function modelLabel(model) {
  const [base, variant] = String(model || "").split("#");
  const { provider, name } = modelParts(base), m = MODELS[name];
  const label = m && provider ? `${m.name} · ${PROVIDER_NAMES[provider] ?? provider}` : base;
  return label ? `${label}${variant ? ` · ${variant}` : ""}` : "Not configured";
}

// the model that wrote a report, without its provider and reasoning setting:
// "spacexai/grok-4.7#medium" → "grok-4.7"; null when it was not recorded
export function modelName(id) {
  const v = String(id ?? "").trim();
  if (!v || v.startsWith("unknown")) return null;
  const slash = v.match(/^[\w.-]+\/(.+)$/);
  return (slash ? slash[1] : v).split("#")[0].trim();
}

// true when the model costs more at that time (seconds since 1970) at its provider; with no
// model, in OpenCode Go's peak hours
export function isPeak(seconds, model) {
  const peak = model === undefined ? OPENCODE_GO_PEAK : modelInfo(model)?.peak;
  const date = new Date((Number(seconds) || 0) * 1000);
  if (!peak || Number.isNaN(date.getTime())) return false;
  const day = date.getUTCDay(), hour = date.getUTCHours();
  return peak.days.includes(day) && peak.hours.some(([from, to]) => hour >= from && hour < to);
}
