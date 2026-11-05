/**
 * Two-Tier Universal Hook Dispatcher Bridge (`src/dispatcher-bridge.mjs`)
 *
 * A **Universal Hook Dispatcher** is **one single hook entry point wired to EVERY hook call site
 * in the agent lifecycle** (`PreInvocation`/`UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
 * `PermissionRequest`, `SubagentStop`, `Stop`—and now the mid-flight sites `DuringThinking`,
 * `DuringText`, `DuringToolInput`).
 *
 * - **Tier 0 (In-Memory Rolling-Window Filter, ~3-15 µs/chunk)**: Evaluates every SSE chunk in-process
 *   against declarative regex, semantic-prefix (`<tag>:<token>`), and density (`minMatches`) triggers
 *   at microsecond speed with zero subprocess overhead.
 * - **Tier 1 (Universal Dispatcher Escalation)**: Only when Tier 0 matches a candidate trigger,
 *   Tier 0 escalates to the operator's single Universal Hook Dispatcher using the unified event envelope.
 */

import { spawn, spawnSync } from 'node:child_process';
import { MidstreamSession, compileRules } from './engine.mjs';

export const PHASE_TO_HOOK_EVENT_NAME = Object.freeze({
  thinking: 'DuringThinking',
  text: 'DuringText',
  tool_input: 'DuringToolInput',
});

export function buildUniversalHookEnvelope({
  sessionId = 'midstream-session',
  event,
}) {
  const hookEventName = PHASE_TO_HOOK_EVENT_NAME[event.phase] || 'DuringText';
  return {
    hook_event_name: hookEventName,
    phase: event.phase,
    session_id: sessionId,
    block_index: event.blockIndex,
    chunk_index: event.chunkIndex,
    tool_name: event.toolName || null,
    delta: event.delta,
    rolling_window: event.rollingWindow,
    matched_rule: event.ruleId,
    matched_text: event.matchedText,
    match_count: event.matchCount,
  };
}

export function normalizeUniversalDispatcherOutput(rawOut, fallbackEvent) {
  if (!rawOut || typeof rawOut !== 'object') return null;

  const hso = rawOut.hookSpecificOutput || {};
  const rawDecision =
    rawOut.decision ||
    rawOut.action ||
    hso.permissionDecision ||
    hso.decision ||
    null;

  const additionalContext =
    rawOut.additionalContext ??
    rawOut.reason ??
    hso.additionalContext ??
    hso.permissionDecisionReason ??
    undefined;

  const permissionPrompt =
    rawOut.permissionPrompt ??
    hso.permissionPrompt ??
    undefined;

  let replacementDelta =
    rawOut.injectedText ??
    rawOut.replacementDelta ??
    undefined;

  const updatedInput = rawOut.updatedInput ?? hso.updatedInput;
  if (replacementDelta === undefined && updatedInput !== undefined) {
    if (typeof updatedInput === 'string') {
      replacementDelta = updatedInput;
    } else if (updatedInput && typeof updatedInput === 'object') {
      replacementDelta =
        updatedInput.delta ??
        updatedInput.text ??
        JSON.stringify(updatedInput);
    }
  }

  return {
    decision: rawDecision || undefined,
    additionalContext,
    permissionPrompt,
    replacementDelta,
    injectedText: replacementDelta,
    _fallbackRuleId: fallbackEvent?.ruleId,
  };
}

/**
 * Non-blocking async CLI dispatcher runner (`spawn` with Promise) for multi-session proxies.
 */
export function invokeCliUniversalDispatcherAsync(command, args = [], envelope, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          child.kill();
        } catch {}
        resolve(null);
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });

    child.on('error', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(null);
      }
    });

    child.on('close', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        try {
          resolve(stdout.trim() ? JSON.parse(stdout.trim()) : null);
        } catch {
          resolve(null);
        }
      }
    });

    try {
      child.stdin.write(JSON.stringify(envelope));
      child.stdin.end();
    } catch {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(null);
      }
    }
  });
}

/**
 * Synchronous CLI dispatcher runner for single-session synchronous call sites.
 */
export function invokeCliUniversalDispatcher(command, args = [], envelope, { timeoutMs = 3000 } = {}) {
  const res = spawnSync(command, args, {
    input: JSON.stringify(envelope),
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  });

  if (res.error || !res.stdout) {
    return null;
  }

  try {
    return JSON.parse(res.stdout.trim());
  } catch {
    return null;
  }
}

function mergeDefinedFields(base, overlay) {
  if (!overlay || typeof overlay !== 'object') return base;
  const merged = { ...(base && typeof base === 'object' ? base : {}) };
  for (const [k, v] of Object.entries(overlay)) {
    if (v !== undefined) {
      merged[k] = v;
    }
  }
  return merged;
}

export function createUniversalDispatcherBridge({
  rules = [],
  sessionId = 'midstream-session',
  onMatchDispatch = null,
  cliDispatcher = null,
  windowSize = 256,
  deferIncompleteWords = true,
} = {}) {
  const dispatchMetrics = {
    tier0ChunksEvaluated: 0,
    tier1Dispatches: 0,
    dispatchedEvents: [],
  };

  let asyncMode = false;

  const bridgedRules = rules.map((rule) => {
    const userHandler = typeof rule.handler === 'function' ? rule.handler : null;
    return {
      ...rule,
      handler(event) {
        dispatchMetrics.tier1Dispatches += 1;
        const envelope = buildUniversalHookEnvelope({ sessionId, event });
        dispatchMetrics.dispatchedEvents.push(envelope);

        if (asyncMode) {
          return (async () => {
            let customResult = null;
            if (userHandler) {
              customResult = await userHandler(event, envelope);
            }
            if (onMatchDispatch) {
              const dispOut = await onMatchDispatch(envelope, event);
              const normalized = normalizeUniversalDispatcherOutput(dispOut, event);
              if (normalized) {
                customResult = mergeDefinedFields(customResult, normalized);
              }
            } else if (cliDispatcher && cliDispatcher.command) {
              const dispOut = await invokeCliUniversalDispatcherAsync(
                cliDispatcher.command,
                cliDispatcher.args || [],
                envelope,
                { timeoutMs: cliDispatcher.timeoutMs || 3000 }
              );
              const normalized = normalizeUniversalDispatcherOutput(dispOut, event);
              if (normalized) {
                customResult = mergeDefinedFields(customResult, normalized);
              }
            }
            return customResult;
          })();
        }

        let customResult = null;
        if (userHandler) {
          customResult = userHandler(event, envelope);
        }

        if (onMatchDispatch) {
          const dispOut = onMatchDispatch(envelope, event);
          const normalized = normalizeUniversalDispatcherOutput(dispOut, event);
          if (normalized) {
            customResult = mergeDefinedFields(customResult, normalized);
          }
        } else if (cliDispatcher && cliDispatcher.command) {
          const dispOut = invokeCliUniversalDispatcher(
            cliDispatcher.command,
            cliDispatcher.args || [],
            envelope,
            { timeoutMs: cliDispatcher.timeoutMs || 3000 }
          );
          const normalized = normalizeUniversalDispatcherOutput(dispOut, event);
          if (normalized) {
            customResult = mergeDefinedFields(customResult, normalized);
          }
        }

        return customResult;
      },
    };
  });

  const compiledRules = compileRules(bridgedRules);
  const session = new MidstreamSession({
    rules: compiledRules,
    windowSize,
    deferIncompleteWords,
  });

  return {
    sessionId,
    rules: compiledRules,
    session,
    dispatchMetrics,
    onBlockStart(params) {
      return session.onBlockStart(params);
    },
    onBlockStop(index) {
      return session.onBlockStop(index);
    },
    async onBlockStopAsync(index) {
      const prev = asyncMode;
      asyncMode = true;
      try {
        return await session.onBlockStopAsync(index);
      } finally {
        asyncMode = prev;
      }
    },
    onDelta(params) {
      dispatchMetrics.tier0ChunksEvaluated += 1;
      return session.onDelta(params);
    },
    async onDeltaAsync(params) {
      dispatchMetrics.tier0ChunksEvaluated += 1;
      const prev = asyncMode;
      asyncMode = true;
      try {
        return await session.onDeltaAsync(params);
      } finally {
        asyncMode = prev;
      }
    },
    getSummaryMetrics() {
      return {
        ...session.getSummaryMetrics(),
        tier0ChunksEvaluated: dispatchMetrics.tier0ChunksEvaluated,
        tier1Dispatches: dispatchMetrics.tier1Dispatches,
        dispatchedEvents: dispatchMetrics.dispatchedEvents,
      };
    },
  };
}
