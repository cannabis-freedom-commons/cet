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
export const PROVIDER_NAMES = { openai: "OpenAI", swancloud: "Swancloud", "opencode-go": "OpenCode Go" };

// the providers whose subscription is the one configured on the server (RESEARCH_PLAN_USD and
// RESEARCH_PLAN_ALLOWANCE_USD: OpenCode Go, $10 a month); a model there without a `planMultiplier`
// of its own takes that plan's ratio. Every other provider without a multiplier is paid as used.
export const CONFIGURED_PLAN_PROVIDERS = ["opencode-go"];

// Each model once, with its price at every provider that offers it. Prices: `input`, `output`;
// `cached` (cache reads) and `cacheWrite` fall back to `input` where no rate of their own was
// supplied; `peak` with `peakInput`/`peakOutput`/`peakCached` for hours that cost more;
// `planMultiplier` divides the API price into what a run takes of a subscription.
export const MODELS = {
  "gpt-6.1-terra": {
    name: "GPT-6.1 Terra", by: "OpenAI",
    providers: {
      // https://openai.com/api/pricing/, standard tier, October 2026; cache writes at the
      // 30-minute retention price
      openai: { input: 1.00, output: 5.00, cached: 0.05, cacheWrite: 1.25 },
    },
  },
  "muse-spark-1.3-contributor": {
    name: "Muse Spark 1.3 Contributor", by: "Meta",
    providers: {
      // operator-supplied rates; a 15× subscription on Swancloud, 6× on OpenCode Go
      swancloud: { input: 0.100, output: 0.200, cached: 0.002, planMultiplier: 15 },
      "opencode-go": { input: 0.10, output: 0.20, cached: 0.002, planMultiplier: 6 },
    },
  },
  "claude-haiku-5.5": {
    name: "Claude Haiku 5.5", by: "Anthropic",
    providers: {
      swancloud: { input: 0.100, output: 0.500, planMultiplier: 15 },
    },
  },
  "deepseek-v4.1-flash": {
    name: "DeepSeek V4.1 Flash", by: "DeepSeek",
    providers: {
      // DeepSeek's own off-peak rates (https://api-docs.deepseek.com/quick_start/pricing), cache
      // hits included; Swancloud has no peak hours
      swancloud: { input: 0.150, output: 0.6, cached: 0.003, planMultiplier: 15 },
      "opencode-go": { input: 0.15, output: 0.6, cached: 0.003, peak: OPENCODE_GO_PEAK, peakInput: 0.3, peakOutput: 1.2, peakCached: 0.006 },
    },
  },
};

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
