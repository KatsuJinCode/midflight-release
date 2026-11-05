/**
 * HTTP/HTTPS Reverse Proxy & Claude Code (`cc-mods`) Integration Adapters (`src/proxy-adapter.mjs`)
 */

import { MidstreamSession, compileRules } from './engine.mjs';
import { createMidstreamSSEInterceptor, isBlockPendingHoldback } from './sse-stream.mjs';
import { DEFAULT_OPERATOR_RULES } from './default-rules.mjs';

/**
 * Drop-in SSE stream wrapper for Node.js HTTP/HTTPS reverse proxies.
 */
export function attachMidstreamToProxyStream({
  proxyRes,
  upstreamReq,
  clientRes,
  rules = DEFAULT_OPERATOR_RULES,
  deferIncompleteWords = true,
  onIntervention = null,
  onInStreamRetry = null,
  holdVisibleTextForRetry = false,
  isContinuationStream = false,
  blockIndexOffset = 0,
  onAsk = null,
}) {
  let inStreamRetrying = false;
  let streamFinished = false;
  const session = new MidstreamSession({ rules, deferIncompleteWords });
  const interceptor = createMidstreamSSEInterceptor({
    session,
    onAsk,
    holdVisibleTextForRetry,
    isContinuationStream,
    blockIndexOffset,
    onForward: (data) => {
      if (!clientRes.writableEnded) {
        clientRes.write(data);
      }
    },
    onInStreamRetry: onInStreamRetry
      ? (verdict, metrics, retryMeta) => {
          inStreamRetrying = true;
          try {
            if (proxyRes && !proxyRes.destroyed) proxyRes.destroy();
          } catch {}
          try {
            if (upstreamReq && !upstreamReq.destroyed) upstreamReq.destroy();
          } catch {}
          if (onIntervention) {
            onIntervention(verdict, metrics, { inStreamRetry: true });
          }
          onInStreamRetry(verdict, metrics, retryMeta);
        }
      : null,
    onAbort: (verdict, metrics) => {
      streamFinished = true;
      try {
        if (proxyRes && !proxyRes.destroyed) {
          proxyRes.destroy();
        }
      } catch {}
      try {
        if (upstreamReq && !upstreamReq.destroyed) {
          upstreamReq.destroy();
        }
      } catch {}
      try {
        if (!clientRes.writableEnded) {
          clientRes.end();
        }
      } catch {}
      if (onIntervention) {
        onIntervention(verdict, metrics, { inStreamRetry: false });
      }
    },
  });

  let asyncChain = Promise.resolve();

  function finalizeStream() {
    if (streamFinished || inStreamRetrying) return;
    streamFinished = true;
    if (interceptor.hasAsyncRules) {
      asyncChain = asyncChain
        .then(async () => {
          if (inStreamRetrying) return;
          await interceptor.endAsync();
          if (inStreamRetrying) return;
          if (!clientRes.writableEnded) {
            clientRes.end();
          }
        })
        .catch(() => {
          if (!inStreamRetrying && !clientRes.writableEnded) {
            try {
              clientRes.end();
            } catch {}
          }
        });
      return;
    }
    interceptor.end();
    if (inStreamRetrying) return;
    if (!clientRes.writableEnded) {
      clientRes.end();
    }
  }

  proxyRes.on('data', (chunk) => {
    if (inStreamRetrying || streamFinished) return;
    if (interceptor.hasAsyncRules) {
      asyncChain = asyncChain.then(() => {
        if (!inStreamRetrying && !streamFinished) {
          return interceptor.pushAsync(chunk);
        }
      });
    } else {
      interceptor.push(chunk);
    }
  });
  proxyRes.on('end', () => {
    finalizeStream();
  });
  proxyRes.on('error', () => {
    finalizeStream();
  });
  proxyRes.on('close', () => {
    finalizeStream();
  });

  return { session, interceptor };
}

/**
 * Creates a `turn.step` async generator hook for Claude Code's `cc-mods` plugin API.
 */
export function createCcModsTurnStepHook({
  rules = DEFAULT_OPERATOR_RULES,
  deferIncompleteWords = true,
  onIntervention = null,
  onAsk = null,
} = {}) {
  const compiled = compileRules(rules);

  return async function* midstreamTurnStepHook($, e, next) {
    const session = new MidstreamSession({ rules: compiled, deferIncompleteWords });
    const stream = next(e);
    const heldByBlock = new Map();

    const getHeldQueue = (idx) => {
      let q = heldByBlock.get(idx);
      if (!q) {
        q = [];
        heldByBlock.set(idx, q);
      }
      return q;
    };

    const trimHeldQueue = (queue, charsToTrim) => {
      let remaining = charsToTrim;
      for (let i = queue.length - 1; i >= 0 && remaining > 0; i--) {
        const item = queue[i];
        const key = item.kind === 'input' ? 'json' : 'text';
        const val = String(item[key] || '');
        if (val.length <= remaining) {
          remaining -= val.length;
          queue.splice(i, 1);
        } else {
          item[key] = val.slice(0, val.length - remaining);
          remaining = 0;
        }
      }
    };

    for await (const chunk of stream) {
      if (chunk.kind === 'tool') {
        session.onBlockStart({
          index: chunk.index ?? 0,
          type: 'tool_use',
          toolName: chunk.name,
          toolId: chunk.id,
        });
      } else if (chunk.kind === 'thinking' || chunk.kind === 'text' || chunk.kind === 'input') {
        const blockIdx = chunk.index ?? 0;
        const phase =
          chunk.kind === 'thinking'
            ? 'thinking'
            : chunk.kind === 'input'
              ? 'tool_input'
              : 'text';
        const delta = chunk.kind === 'input' ? chunk.json : chunk.text;
        const queue = getHeldQueue(blockIdx);

        const verdict = await session.onDeltaAsync({
          index: blockIdx,
          phase,
          delta,
        });

        if (verdict.decision === 'ask' && onAsk) {
          const askRes = await onAsk(verdict, session.getSummaryMetrics());
          if (
            askRes === false ||
            (askRes && typeof askRes === 'object' && (askRes.decision === 'abort' || askRes.decision === 'block' || askRes.decision === 'deny'))
          ) {
            verdict.decision = 'abort';
          }
        }

        if (verdict.decision === 'abort') {
          if (verdict.spanPrefixCharsInPrevChunks > 0 && queue.length > 0) {
            trimHeldQueue(queue, verdict.spanPrefixCharsInPrevChunks);
          }
          for (const held of queue) {
            yield held;
          }
          queue.length = 0;
          if (verdict.safeDeltaPrefix) {
            if (chunk.kind === 'input') {
              yield { ...chunk, json: verdict.safeDeltaPrefix };
            } else {
              yield { ...chunk, text: verdict.safeDeltaPrefix };
            }
          }
          if (onIntervention) {
            await onIntervention($, e, verdict, session.getSummaryMetrics());
          }
          const noticeText = `\n\n⚡ [Midstream Hook Aborted (${verdict.ruleId})]\n${verdict.additionalContext}`;
          yield { kind: 'text', index: blockIdx + 1, text: noticeText };
          yield { kind: 'stop', stopReason: 'end_turn', usage: null };
          return {
            turnId: e.turnId,
            index: e.index,
            answer: noticeText,
            toolUses: [],
            stopReason: 'end_turn',
            usage: null,
          };
        }

        if (verdict.decision === 'inject') {
          if (verdict.spanPrefixCharsInPrevChunks > 0 && queue.length > 0) {
            trimHeldQueue(queue, verdict.spanPrefixCharsInPrevChunks);
          }
          for (const held of queue) {
            yield held;
          }
          queue.length = 0;
          const rewritten = verdict.injectedText ?? verdict.replacementDelta ?? delta;
          if (chunk.kind === 'input') {
            yield { ...chunk, json: rewritten };
          } else if (rewritten.length > 0) {
            yield { ...chunk, text: rewritten };
          }
          continue;
        }

        const block = session.blocks.get(blockIdx);
        if (isBlockPendingHoldback(block, session.rules)) {
          queue.push({ ...chunk });
          continue;
        }
        for (const held of queue) {
          yield held;
        }
        queue.length = 0;
      }

      yield chunk;
    }

    for (const idx of session.blocks.keys()) {
      const queue = getHeldQueue(idx);
      const stopV = await session.onBlockStopAsync(idx);
      if (stopV && stopV.decision === 'abort') {
        const matchedLen = (stopV.matchedText || '').length;
        if (matchedLen > 0 && queue.length > 0) {
          trimHeldQueue(queue, matchedLen);
        }
        for (const held of queue) {
          yield held;
        }
        queue.length = 0;
        if (onIntervention) {
          await onIntervention($, e, stopV, session.getSummaryMetrics());
        }
        const noticeText = `\n\n⚡ [Midstream Hook Aborted (${stopV.ruleId})]\n${stopV.additionalContext}`;
        yield { kind: 'text', index: idx + 1, text: noticeText };
        yield { kind: 'stop', stopReason: 'end_turn', usage: null };
        return {
          turnId: e.turnId,
          index: e.index,
          answer: noticeText,
          toolUses: [],
          stopReason: 'end_turn',
          usage: null,
        };
      }
      for (const held of queue) {
        yield held;
      }
      queue.length = 0;
    }

    return await stream.result;
  };
}
