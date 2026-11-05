# Midflight (`midstream-hooks`)

**Deterministic Mid-Flight Token Hooks (`DuringThinking`, `DuringText`, `DuringToolInput`) with `Slipstream` & `FlyByWire` Modes, Universal Hook Dispatcher Bridge, and Semantic Acknowledgement Prefixes.**

Every LLM agent harness today (`Claude Code`, `Codex`, `Cursor`, `OpenCode`, `MiniMax`) exposes hooks at **turn or tool boundaries** (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`). None of them expose a **Midstream ("During") Hook Call Site** while tokens are actively streaming in.

`midstream-hooks` adds that missing call site—evaluating streaming tokens in **~2.4 microseconds median (`4.18–9.53 µs` mean / `2.09 µs/token`) per chunk** across `thinking`, `text`, and `tool_input`, and firing the harness's native stop/abort the instant a deterministic policy rule is violated.

---

## Core Concepts

### 1. The Three Midstream Phases
Modern LLM SSE streams multiplex tokens into three distinct sub-streams, all of which `midstream-hooks` inspects live before a block finishes:
- **`thinking` (`thinking_delta`)**: Catch bad plans or deprecated tools inside open/unredacted reasoning traces (e.g., MiniMax, DeepSeek, Qwen, GLM) *before* text or tool calls even start.
- **`tool_input` (`input_json_delta`)**: Catch forbidden CLI commands or file writes on token 5 of a streaming JSON payload instead of waiting 30 seconds for `PreToolUse`.
- **`text` (`text_delta`)**: Catch policy violations in visible assistant prose as it streams.

### 2. Semantic Acknowledgement Prefixes (`ackPrefix`)
When a rule bans a concept (like `wrangler`), the agent often still needs to *think about* or *refer to* it (e.g., explaining a migration or acknowledging the rule).

Rules can declare a semantic `ackPrefix` (such as `deprecated:`, `forbidden:`, `legacy:`):
- **Unprefixed (`wrangler`)**: Immediately aborts the stream and injects the rule's `additionalContext`.
- **Prefixed (`deprecated:wrangler`)**: Allowed through in `thinking` and `text` as cryptographic/behavioral proof that the model is aware of the policy, while still blocked in `tool_input` (`allowAckIn: ['thinking', 'text']`) so it can never be executed.
- **Automatic Self-Modeling Prompt Sanitization**: `compileRules()` automatically rewrites any bare occurrences of the target pattern inside a rule's own `additionalContext` to `<ackPrefix><match>` (`deprecated:wrangler`) so the policy prompt never poisons the LLM's autoregressive context with an unprefixed example.

---

## Package Layout

- [`PAPER.md`](./PAPER.md) — Overview paper summarizing the architecture, 302-stream unpoisoned benchmark (`1/40` Control, `34/40` fair / `37/40` raw step-boundary retry, `35/36` Turn 1 violations intercepted (`31/35` in `<thinking>`, `8/10` in Scenario 1), `31/35` recovered for `33/40` full Midflight retry, and `25/40` in-flight swap (`20/20` in Scenarios 3–4)), and the Pink Elephant `<thinking>` paradox.
- [`docs/TECHNICAL-REFERENCE.md`](./docs/TECHNICAL-REFERENCE.md) — Full technical reference and methodology disclosures.
- [`src/engine.mjs`](./src/engine.mjs) — `MidstreamSession` (`deferIncompleteWords: true` by default), `compileRules`, `createTieredSignalRule`, `createEarlySyntaxValidationRule`, `createPreMutationSnapshotRule`, `createSpeculativePrefetchRule`, `sanitizeInstructionWithPrefix`, `sanitizeRequestMessages`, `buildRetryRequestBody`, and `buildPrefillContinuationBody`.
- [`src/sse-stream.mjs`](./src/sse-stream.mjs) — Client SSE consumer (`consumeSSEWithMidstreamHooks`), synchronous/async SSE line evaluators (`evaluateSSELine`, `evaluateSSELineAsync`), and reverse-proxy SSE interceptor (`createMidstreamSSEInterceptor`).
- [`src/default-rules.mjs`](./src/default-rules.mjs) — Default `FlyByWire` (`action: 'abort'`) ruleset (`cloudflare-no-wrangler`, `no-test-skip-or-ts-ignore`, `no-lazy-code-truncation`, `no-git-verify-bypass`, `no-live-secret-emission`, `browser-use-managed-session`, `no-interactive-question-modal`). Pass `action: 'rewrite'` rules (such as `REWRITE_RULES` in `benchmark-unpoisoned.mjs`) for single-turn `Slipstream` token rewriting.
- [`src/proxy-adapter.mjs`](./src/proxy-adapter.mjs) — Drop-in adapters for Node HTTP/HTTPS reverse proxies (`attachMidstreamToProxyStream({ proxyRes, upstreamReq, clientRes })`) and generator-based turn hooks (`createCcModsTurnStepHook`).
- [`src/dispatcher-bridge.mjs`](./src/dispatcher-bridge.mjs) — Two-Tier Universal Hook Dispatcher Bridge (`createUniversalDispatcherBridge`).
- [`bin/midstream-proxy.mjs`](./bin/midstream-proxy.mjs) — Standalone local SSE proxy (`ANTHROPIC_BASE_URL=http://127.0.0.1:9885`).
- [`benchmark-unpoisoned.mjs`](./benchmark-unpoisoned.mjs) & [`unpoisoned-results.json`](./unpoisoned-results.json) — Multi-trial pressure and uncertainty-gradient benchmark suite (`302` live streams).
- [`benchmark-litellm-gateway.mjs`](./benchmark-litellm-gateway.mjs) & [`litellm-gateway-results.json`](./litellm-gateway-results.json) — 6-condition $N=3$ factorial evaluation and live proxy auto-retry suite (`112` live streams).
- [`benchmark-top5.mjs`](./benchmark-top5.mjs) & [`benchmark-results.json`](./benchmark-results.json) — Single-trial 5-condition evaluation across 6 scenarios (`32` live streams).
- [`benchmark-benign-corpus.mjs`](./benchmark-benign-corpus.mjs) & [`benign-corpus-results.json`](./benign-corpus-results.json) — 50-stream benign corpus benchmark (`50/50` clean at 7-char chunks, `2,000/2,000` clean across chunk sizes `1..40`, and `128 KB` contiguous base64url stress test).
- [`poc-minimax.mjs`](./poc-minimax.mjs) — Minimal standalone live SSE proof-of-concept script (`MINIMAX_API_KEY`).
- [`test/midstream.test.mjs`](./test/midstream.test.mjs) — Automated test suite (`npm test`).
