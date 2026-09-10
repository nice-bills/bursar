/**
 * A deterministic model, so the agent can be exercised without a paid key.
 *
 * This is NOT a language model. It returns fixed text, which is exactly what
 * we want when the thing under test is the plugin wiring: whether the runtime
 * starts our service, composes our provider into state, and dispatches our
 * actions. A real model would make those assertions flaky for reasons that
 * have nothing to do with the treasury.
 *
 * Swap it for @elizaos/plugin-openai or @elizaos/plugin-anthropic to have a
 * real model choose the actions; the plugin surface it exercises is identical.
 */

import { ModelType, type Plugin } from "@elizaos/core";

export const stubModelPlugin: Plugin = {
  name: "stub-model",
  description:
    "Deterministic stand-in for a language model, so plugin wiring can be tested " +
    "without a model provider key.",

  models: {
    [ModelType.TEXT_SMALL]: async () => "ok",
    [ModelType.TEXT_LARGE]: async () => "ok",
    // Embeddings must be a fixed-width vector or the memory layer rejects them.
    [ModelType.TEXT_EMBEDDING]: async () => new Array(384).fill(0),
  },
};
