/**
 * Live Proof of Concept: Midstream Deterministic Hook + Semantic Acknowledgement Token (`deprecated:wrangler`)
 *
 * Tests the "During" hook call site (`DuringThinking`, `DuringText`, `DuringToolInput`)
 * against live `MiniMax-M3.1-Flash` with a semantic prefix shibboleth (`deprecated:`).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MidstreamSession,
  consumeSSEWithMidstreamHooks,
} from './src/index.mjs';

const MINIMAX_ENDPOINT = 'https://api.minimax.io/anthropic/v1/messages';
const MODEL = 'MiniMax-M3.1-Flash';

function loadMiniMaxKey() {
  const key = process.env.MINIMAX_API_KEY;
  if (!key) throw new Error('Missing MINIMAX_API_KEY environment variable');
  return key;
}

const TOOLS = [
  {
    name: 'Bash',
    description: 'Execute a shell command on the local machine.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The exact shell command to run' },
        description: { type: 'string', description: 'Brief description of the command' },
      },
      required: ['command'],
    },
  },
];

// Declarative rule using `ackPrefix: 'deprecated:'`
const MIDSTREAM_RULES = [
  {
    id: 'cloudflare-no-wrangler',
    phases: ['thinking', 'text', 'tool_input'],
    pattern: /\bwrangler(?:\.toml|\.jsonc?)?\b/i,
    ackPrefix: 'deprecated:',
    action: 'abort',
    additionalContext: [
      'MIDSTREAM POLICY INTERVENTION (rule: cloudflare-no-wrangler):',
      'Your generation was interrupted mid-stream because you emitted the forbidden token without its `deprecated:` prefix.',
      '1. Cloudflare replaced `deprecated:wrangler` with the unified `cf` CLI (`cf deploy`, `cf d1 create <name>`, `cf.json`). Never invoke `deprecated:wrangler` in commands.',
      '2. SEMANTIC ACKNOWLEDGEMENT TOKEN (`deprecated:`): Every single time that word appears anywhere in your <thinking> or response text, it MUST be written `deprecated:wrangler` (or `deprecated:wrangler.toml`). Never write the word without `deprecated:` attached to the front of it.',
    ].join('\n'),
  },
];

async function streamMiniMaxTurn({ apiKey, messages, rules, label }) {
  const abortController = new AbortController();
  const session = new MidstreamSession({ rules, deferIncompleteWords: true });
  const tStart = performance.now();

  console.log(`\n======================================================================`);
  console.log(`▶ ${label}`);
  console.log(`======================================================================`);

  let currentPhase = null;

  const response = await fetch(MINIMAX_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      thinking: { type: 'enabled', budget_tokens: 2048 },
      stream: true,
      system: 'You are a pragmatic coding assistant. Briefly explain the command you are running, then use the Bash tool to deploy the Worker and create the D1 database.',
      tools: TOOLS,
      messages,
    }),
    signal: abortController.signal,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`HTTP ${response.status}: ${errText}`);
  }

  const result = await consumeSSEWithMidstreamHooks({
    response,
    abortController,
    session,
    onToken: ({ phase, delta, toolName }) => {
      const tag = phase === 'tool_input' ? `TOOL_INPUT(${toolName || 'tool'})` : phase.toUpperCase();
      if (tag !== currentPhase) {
        currentPhase = tag;
        process.stdout.write(`\n[${tag}] `);
      }
      process.stdout.write(delta);
    },
  });

  const elapsedMs = Math.round(performance.now() - tStart);
  console.log('\n');

  if (result.aborted && result.verdict) {
    const v = result.verdict;
    console.log(`⚡ [MIDSTREAM HOOK FIRED -> NATIVE STOP]`);
    console.log(`   • Rule Triggered   : ${v.ruleId} (requires prefix "${v.ackPrefix}")`);
    console.log(`   • Caught In Phase  : ${v.phase.toUpperCase()} (block #${v.blockIndex}, chunk #${v.chunkIndex})`);
    console.log(`   • Unprefixed Match : "${v.matchedText}"`);
    console.log(`   • Time to Intercept: ${elapsedMs} ms (stopped immediately mid-stream)`);
    console.log(`   • Hook Eval Latency: ${v.evalUs.toFixed(2)} µs on trigger chunk (avg ${result.metrics.avgEvalUs} µs across ${result.metrics.chunksEvaluated} chunks)`);
    console.log(`   • Stream Cut At    : ${result.metrics.charsStreamed} chars`);
  } else {
    console.log(`✅ [STREAM COMPLETED CLEANLY]`);
    console.log(`   • Stop Reason      : ${result.stopReason}`);
    console.log(`   • Elapsed Time     : ${elapsedMs} ms`);
    console.log(`   • Hook Eval Latency: avg ${result.metrics.avgEvalUs} µs, max ${result.metrics.maxEvalUs} µs across ${result.metrics.chunksEvaluated} chunks (${result.metrics.charsStreamed} chars)`);
    if (result.metrics.acknowledgedReferences.length > 0) {
      console.log(`   • Policy-Aware Refs: ${result.metrics.acknowledgedReferences.length} acknowledged token(s) allowed through:`);
      for (const ref of result.metrics.acknowledgedReferences) {
        console.log(`       - "${ref.token}" in ${ref.phase.toUpperCase()} (chunk #${ref.chunkIndex})`);
      }
    }
  }

  return result;
}

async function main() {
  const apiKey = loadMiniMaxKey();
  const userPrompt =
    "We have a Cloudflare Worker project with a wrangler.toml file. Run the CLI command to deploy our Worker to production and create a D1 database named 'orders-db'.";

  console.log(`Prompt: "${userPrompt}"`);
  console.log(`Target: ${MODEL} (${MINIMAX_ENDPOINT})`);

  // Turn 1: Unsteered generation — MiniMax naturally reaches for bare `wrangler`
  const step1 = await streamMiniMaxTurn({
    apiKey,
    label: 'TURN 1: Unsteered Generation (Midstream Hook Active)',
    rules: MIDSTREAM_RULES,
    messages: [{ role: 'user', content: userPrompt }],
  });

  if (step1.aborted && step1.verdict) {
    console.log(`\n----------------------------------------------------------------------`);
    console.log(`💉 Injecting Hook Policy (with \`deprecated:\` prefix rule)...`);
    console.log(`----------------------------------------------------------------------`);
    console.log(step1.verdict.additionalContext);

    const steeredMessages = [
      { role: 'user', content: userPrompt },
      {
        role: 'user',
        content: `<system-reminder>\n${step1.verdict.additionalContext}\n</system-reminder>`,
      },
    ];

    await streamMiniMaxTurn({
      apiKey,
      label: 'TURN 2: Steered Generation Using Semantic Token `deprecated:wrangler`',
      rules: MIDSTREAM_RULES,
      messages: steeredMessages,
    });
  }
}

main().catch((err) => {
  console.error('PoC Error:', err);
  process.exit(1);
});
