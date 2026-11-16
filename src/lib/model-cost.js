// What a research run costs: its tokens at the model's prices, and its share of a subscription.
// The models, providers, prices and plans are defined in src/lib/models.js.
import { baseModel, CONFIGURED_PLAN_PROVIDERS, isPeak, modelInfo, modelParts } from "./models.js";

export { baseModel, isPeak };
// true when the model has a price at its provider
export const isPriced = (model) => Boolean(modelInfo(model));

// What a run's tokens cost, part by part, in USD: fresh input, cache reads, cache writes and output
// (reasoning included), at the model's prices for the hour the run started. `cachedAtInput` /
// `writeAtInput` say that no cache price was supplied, so those tokens are counted as fresh input.
// null when the model has no price.
export function costParts(run) {
  const price = modelInfo(run?.model);
  if (!price) return null;
  const peak = isPeak(run.started_at || run.created_at, run.model);
  const input = peak ? (price.peakInput ?? price.input) : price.input;
  const output = peak ? (price.peakOutput ?? price.output) : price.output;
  const cached = (peak ? price.peakCached : undefined) ?? price.cached ?? input;
  const cacheWrite = price.cacheWrite ?? input;
  const n = (k) => Number(run?.[k] || 0);
  const parts = {
    input: (n("input_tokens") * input) / 1e6,
    cacheRead: (n("cache_read_tokens") * cached) / 1e6,
    cacheWrite: (n("cache_write_tokens") * cacheWrite) / 1e6,
    output: ((n("output_tokens") + n("reasoning_tokens")) * output) / 1e6,
    cachedAtInput: price.cached == null, writeAtInput: price.cacheWrite == null,
  };
  parts.total = parts.input + parts.cacheRead + parts.cacheWrite + parts.output;
  return parts;
}

// the run's cost in USD: what OpenCode reported if it did, otherwise its tokens at the price for
// the hour it started; 0 when neither is known
export function runCost(run) {
  const reported = Number(run?.cost_usd || 0);
  if (reported > 0) return reported;
  return costParts(run)?.total ?? 0;
}

// Estimated subscription allocation: the model’s fixed plan multiplier takes priority over the
// configured price/allowance ratio (RESEARCH_PLAN_*), which covers only the providers in
// CONFIGURED_PLAN_PROVIDERS; API keys (OpenAI, xAI…) are paid as used. null when no plan covers it.
export function modelPlan(model, plan) {
  const info = modelInfo(model);
  if (info?.planMultiplier > 0) return { multiplier: info.planMultiplier };
  if (!CONFIGURED_PLAN_PROVIDERS.includes(modelParts(baseModel(model)).provider)) return null;
  return plan?.multiplier > 0 || (plan?.price_usd > 0 && plan?.allowance_usd > 0) ? plan : null;
}
export function planDescription(plan) {
  return plan?.multiplier > 0 ? `${plan.multiplier}× plan (API value ÷ ${plan.multiplier})`
    : `$${plan?.price_usd} a month plan with $${plan?.allowance_usd} of usage`;
}
export function displayedRunCost(run, plan) {
  const api = runCost(run);
  return planCost(api, plan, run?.model) || api;
}
export function planCost(apiCost, plan, model) {
  plan = modelPlan(model, plan);
  if (plan?.multiplier > 0) return apiCost / plan.multiplier;
  const price = Number(plan?.price_usd || 0), allowance = Number(plan?.allowance_usd || 0);
  return price > 0 && allowance > 0 ? (apiCost * price) / allowance : 0;
}

// true when the cost shown is worked out from tokens rather than reported by OpenCode
export function costEstimated(run) {
  return !(Number(run?.cost_usd || 0) > 0) && isPriced(run?.model);
}

// A run costs a fraction of a cent, so keep four decimals ($0.0001) rather than rounding to cents;
// the smallest runs get six so they do not show as $0.0000. 0 (unknown) is shown as a dash.
export function formatUSD(value) {
  const v = Number(value) || 0;
  if (!v) return "—";
  return `$${v.toFixed(v < 0.0001 ? 6 : 4)}`;
}
