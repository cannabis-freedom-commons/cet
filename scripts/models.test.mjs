import test from "node:test";
import assert from "node:assert/strict";
import { MODELS, PROVIDER_NAMES, MODEL_IDS, modelInfo, modelLabel, isPeak } from "../src/lib/models.js";
import { runCost } from "../src/lib/model-cost.js";

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

test("peak hours belong to the provider's price", () => {
  const monday2am = Date.UTC(2026, 9, 26, 2) / 1000;
  assert.equal(isPeak(monday2am, "opencode-go/deepseek-v4.1-flash"), true);
  assert.equal(isPeak(monday2am, "swancloud/deepseek-v4.1-flash"), false);
  assert.equal(isPeak(monday2am, "openai/gpt-6.1-terra"), false);
});
