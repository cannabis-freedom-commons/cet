import test from "node:test";
import assert from "node:assert/strict";
import { MODELS, PROVIDER_NAMES, MODEL_IDS, modelInfo, modelLabel, isPeak, standardModel, apiPrice } from "../src/lib/models.js";
import { runCost, apiCostParts } from "../src/lib/model-cost.js";

test("every model has a name and, at each provider, a named provider and prices", () => {
  for (const [name, m] of Object.entries(MODELS)) assert.ok(m.name && m.by, `${name} has no name or maker`);
  for (const id of MODEL_IDS) {
    const m = modelInfo(id);
    assert.ok(m.input > 0 && m.output > 0, `${id} has no input/output price`);
    assert.ok(PROVIDER_NAMES[m.provider], `${id}: provider not in PROVIDER_NAMES`);
  }
});

test("labels name the model and provider, with the reasoning variant", () => {
  assert.equal(modelLabel("openai/gpt-6.1-terra#medium"), "GPT-6.1 Terra · OpenAI · medium");
  assert.equal(modelLabel("swancloud/claude-haiku-5.5"), "Claude Haiku 5.5 · Swancloud");
  assert.equal(modelLabel("acme/unknown-1"), "acme/unknown-1");
  assert.equal(modelLabel(""), "Not configured");
});

test("the same model has each provider's own plan", () => {
  assert.equal(modelInfo("swancloud/deepseek-v4.1-flash").planMultiplier, 15);
  assert.equal(modelInfo("swancloud/muse-spark-1.3-contributor").planMultiplier, 15);
  assert.equal(modelInfo("opencode-go/muse-spark-1.3-contributor").planMultiplier, 6);
  assert.equal(modelInfo("openrouter/muse-spark-1.3-contributor"), undefined);
  assert.equal(modelInfo("openai/gpt-6.1-terra").planMultiplier, undefined);
});

test("GPT-6.1 Terra is priced at OpenAI's standard rates, cache writes included", () => {
  const run = { model: "openai/gpt-6.1-terra#medium", input_tokens: 1e6, output_tokens: 1e6, cache_read_tokens: 1e6, cache_write_tokens: 1e6 };
  assert.equal(runCost(run), 1 + 5 + 0.05 + 1.25);
});

test("a recorded model name finds the maker's list price, whoever served it", () => {
  assert.equal(standardModel("nvidia/minimaxai/minimax-m3.1-flash#thinking"), "minimax-m3.1-flash");
  assert.equal(standardModel("openrouter/inclusionai/ling-3.2-flash:free"), "ling-3.2-flash");
  assert.equal(standardModel("swancloud/grok-4.7-free"), "grok-4.7");
  assert.equal(standardModel("opencode-go/hy4-flash-free#high"), "hy4-flash");
  assert.equal(standardModel("muse/muse-spark-1.3#xhigh"), "muse-spark-1.3");
  assert.equal(standardModel("acme/unknown-1"), "");
  assert.equal(apiPrice("xai/grok-4.7#low").input, 2);
  assert.equal(apiPrice("opencode-go/beam-free#max"), null, "a free preview has no list price");
  for (const [name, m] of Object.entries(MODELS)) {
    assert.ok(m.api === null || (m.api.input > 0 && m.api.output > 0 && m.api.source), `${name}: list price needs input, output and a source, or null`);
  }
  // the same tokens cost the same at list price, on any provider
  const tokens = { input_tokens: 1e6, output_tokens: 1e6, cache_read_tokens: 1e6 };
  assert.equal(apiCostParts({ model: "swancloud/deepseek-v4.1-flash#max", ...tokens }).total, apiCostParts({ model: "opencode-go/deepseek-v4.1-flash#max", ...tokens }).total);
  assert.equal(apiCostParts({ model: "openai/gpt-6.1-terra", ...tokens }).total, 1 + 5 + 0.05);
});

test("peak hours belong to the provider's price", () => {
  const monday2am = Date.UTC(2026, 9, 26, 2) / 1000;
  assert.equal(isPeak(monday2am, "opencode-go/deepseek-v4.1-flash"), true);
  assert.equal(isPeak(monday2am, "swancloud/deepseek-v4.1-flash"), false);
  assert.equal(isPeak(monday2am, "openai/gpt-6.1-terra"), false);
});
