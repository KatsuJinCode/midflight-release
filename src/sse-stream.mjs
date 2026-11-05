/**
 * SSE Stream Interceptors (`src/sse-stream.mjs`)
 *
 * Supports both:
 * 1. Client/SDK Stream Consumption (`consumeSSEWithMidstreamHooks`) — triggers native `AbortController.abort()`
 * 2. Reverse-Proxy Stream Interception (`createMidstreamSSEInterceptor`) — drops into `anthropic-proxy.js`
 *    or any SSE proxy, supports in-flight stream redaction/rewriting (`decision: 'inject'`), holds back
 *    incomplete `tool_use` JSON blocks until `content_block_stop` so mid-tool aborts never cause downstream
 *    `JSON.parse()` syntax errors, and emits a clean synthetic SSE termination sequence downstream.
 */

import { StringDecoder } from 'node:string_decoder';

function resolveChoiceSlotFromBlockIndex(evt, targetBlockIndex) {
  if (!Array.isArray(evt?.choices) || evt.choices.length === 0) return 0;
  if (typeof targetBlockIndex !== 'number') return 0;
  const targetChoiceIdx = Math.floor(targetBlockIndex / 100);
  const found = evt.choices.findIndex((c, idx) => (c?.index ?? idx) === targetChoiceIdx);
  return found >= 0 ? found : 0;
}

function resolveCandidateSlotFromBlockIndex(evt, targetBlockIndex) {
  if (!Array.isArray(evt?.candidates) || evt.candidates.length === 0) return 0;
  if (typeof targetBlockIndex !== 'number') return 0;
  const targetCandIdx = Math.floor(targetBlockIndex / 100);
  const found = evt.candidates.findIndex((c, idx) => (c?.index ?? idx) === targetCandIdx);
  return found >= 0 ? found : 0;
}

function setDeltaPayloadText(evt, newText, toolCallSlot = 0, targetPhase = null, targetBlockIndex = null) {
  if (!evt) return evt;
  if (evt.type === 'content_block_delta' && evt.delta) {
    const clone = structuredClone(evt);
    if (clone.delta.type === 'thinking_delta') {
      clone.delta.thinking = newText;
    } else if (clone.delta.type === 'text_delta') {
      clone.delta.text = newText;
    } else if (clone.delta.type === 'input_json_delta') {
      clone.delta.partial_json = newText;
    }
    return clone;
  }
  if (Array.isArray(evt.choices) && evt.choices.length > 0) {
    const cSlot = resolveChoiceSlotFromBlockIndex(evt, targetBlockIndex);
    if (!evt.choices[cSlot]?.delta) return evt;
    const clone = structuredClone(evt);
    const d = clone.choices[cSlot].delta;
    if (targetPhase === 'tool_input' && Array.isArray(d.tool_calls) && d.tool_calls[toolCallSlot]?.function) {
      d.tool_calls[toolCallSlot].function.arguments = newText;
    } else if (targetPhase === 'thinking') {
      if (typeof d.reasoning_content === 'string') d.reasoning_content = newText;
      else if (typeof d.reasoning === 'string') d.reasoning = newText;
    } else if (targetPhase === 'text' && typeof d.content === 'string') {
      d.content = newText;
    } else if (Array.isArray(d.tool_calls) && d.tool_calls[toolCallSlot]?.function) {
      d.tool_calls[toolCallSlot].function.arguments = newText;
    } else if (typeof d.reasoning_content === 'string' && d.reasoning_content.length > 0 && typeof d.content !== 'string') {
      d.reasoning_content = newText;
    } else if (typeof d.reasoning === 'string' && d.reasoning.length > 0 && typeof d.content !== 'string') {
      d.reasoning = newText;
    } else if (typeof d.content === 'string') {
      d.content = newText;
    } else if (typeof d.reasoning_content === 'string') {
      d.reasoning_content = newText;
    } else if (typeof d.reasoning === 'string') {
      d.reasoning = newText;
    }
    return clone;
  }
  if (Array.isArray(evt.candidates) && evt.candidates.length > 0) {
    const cSlot = resolveCandidateSlotFromBlockIndex(evt, targetBlockIndex);
    if (!Array.isArray(evt.candidates[cSlot]?.content?.parts)) return evt;
    const clone = structuredClone(evt);
    const parts = clone.candidates[cSlot].content.parts;
    let part = null;
    if (targetPhase === 'thinking') {
      part = parts.find((p) => p && p.thought === true && typeof p.text === 'string') || null;
    } else if (targetPhase === 'text') {
      part = parts.find((p) => p && !p.thought && typeof p.text === 'string') || null;
    } else if (targetPhase === 'tool_input') {
      part = parts.find((p) => p && p.functionCall) || null;
    }
    if (!part) {
      part = parts[toolCallSlot] || parts[0];
    }
    if (part) {
      if (part.functionCall) {
        try {
          part.functionCall.args = JSON.parse(newText);
        } catch {
          part.functionCall.args = newText;
        }
      } else if (typeof part.text === 'string') {
        part.text = newText;
      }
    }
    return clone;
  }
  return evt;
}

function getDeltaPayloadText(evt, targetPhase = null, targetBlockIndex = null) {
  if (!evt) return '';
  if (evt.type === 'content_block_delta' && evt.delta) {
    if (evt.delta.type === 'thinking_delta') return evt.delta.thinking || '';
    if (evt.delta.type === 'text_delta') return evt.delta.text || '';
    if (evt.delta.type === 'input_json_delta') return evt.delta.partial_json || '';
    return '';
  }
  if (Array.isArray(evt.choices) && evt.choices.length > 0) {
    const cSlot = resolveChoiceSlotFromBlockIndex(evt, targetBlockIndex);
    const d = evt.choices[cSlot]?.delta;
    if (!d) return '';
    if (targetPhase === 'tool_input' && Array.isArray(d.tool_calls) && d.tool_calls[0]?.function) {
      return d.tool_calls[0].function.arguments || '';
    }
    if (targetPhase === 'thinking') {
      return d.reasoning_content || d.reasoning || '';
    }
    if (targetPhase === 'text' && typeof d.content === 'string') {
      return d.content;
    }
    if (Array.isArray(d.tool_calls) && d.tool_calls[0]?.function) {
      return d.tool_calls[0].function.arguments || '';
    }
    return d.content || d.reasoning_content || d.reasoning || '';
  }
  if (Array.isArray(evt.candidates) && evt.candidates.length > 0) {
    const cSlot = resolveCandidateSlotFromBlockIndex(evt, targetBlockIndex);
    const parts = evt.candidates[cSlot]?.content?.parts;
    if (!Array.isArray(parts)) return '';
    let part = null;
    if (targetPhase === 'thinking') {
      part = parts.find((p) => p && p.thought === true && typeof p.text === 'string') || null;
    } else if (targetPhase === 'text') {
      part = parts.find((p) => p && !p.thought && typeof p.text === 'string') || null;
    } else if (targetPhase === 'tool_input') {
      part = parts.find((p) => p && p.functionCall) || null;
    }
    if (!part) {
      part = parts.find((p) => p && !p.thought && typeof p.text === 'string') || parts[0];
    }
    if (!part) return '';
    if (part.functionCall) {
      return typeof part.functionCall.args === 'string'
        ? part.functionCall.args
        : JSON.stringify(part.functionCall.args || {});
    }
    return part.text || '';
  }
  return '';
}

const VERDICT_RANK = Object.freeze({ allow: 0, inject: 1, ask: 2, abort: 3 });

function pickHigherVerdict(curr, next) {
  if (!next) return curr;
  if (!curr) return next;
  return (VERDICT_RANK[next.decision] ?? 0) >= (VERDICT_RANK[curr.decision] ?? 0) ? next : curr;
}

/**
 * Parse a single SSE `data: {...}` (or `data:{...}`) line and feed it into `MidstreamSession`.
 *
 * @param {string} line
 * @param {import('./engine.mjs').MidstreamSession} session
 * @param {Function} [onToken]
 * @returns {{ evt: Object|null, verdict: Object|null, rewrittenLine: string|null }}
 */
export function evaluateSSELine(line, session, onToken = null) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return { evt: null, verdict: null, rewrittenLine: null };
  const jsonStr = trimmed.slice(5).trim();
  if (!jsonStr || jsonStr === '[DONE]') return { evt: null, verdict: null, rewrittenLine: null };

  let evt;
  try {
    evt = JSON.parse(jsonStr);
  } catch {
    return { evt: null, verdict: null, rewrittenLine: null };
  }

  if (evt.type === 'content_block_start' && evt.content_block) {
    const cb = evt.content_block;
    session.onBlockStart({
      index: evt.index ?? 0,
      type: cb.type,
      toolName: cb.name || null,
      toolId: cb.id || null,
    });
  } else if (evt.type === 'content_block_delta' && evt.delta) {
    const d = evt.delta;
    const index = evt.index ?? 0;
    let phase = null;
    let deltaText = '';

    if (d.type === 'thinking_delta') {
      phase = 'thinking';
      deltaText = d.thinking || '';
    } else if (d.type === 'text_delta') {
      phase = 'text';
      deltaText = d.text || '';
    } else if (d.type === 'input_json_delta') {
      phase = 'tool_input';
      deltaText = d.partial_json || '';
    }

    if (phase && deltaText) {
      const block = session.blocks.get(index);
      const verdict = session.onDelta({
        index,
        phase,
        delta: deltaText,
        toolName: block?.toolName || null,
      });

      let rewrittenLine = null;
      let effectiveOutText = deltaText;
      if (verdict && verdict.decision === 'inject') {
        effectiveOutText =
          verdict.injectedText !== undefined
            ? verdict.injectedText
            : verdict.replacementDelta ?? deltaText;
        evt = setDeltaPayloadText(evt, effectiveOutText, 0, phase);
        rewrittenLine = `data: ${JSON.stringify(evt)}`;
      }

      if (onToken) {
        onToken({
          phase,
          delta: effectiveOutText,
          rawDelta: deltaText,
          index,
          toolName: block?.toolName || null,
          verdict,
        });
      }

      return { evt, verdict, rewrittenLine };
    }
  } else if (evt.type === 'content_block_stop' && typeof session.onBlockStop === 'function') {
    const stopVerdict = session.onBlockStop(evt.index ?? 0);
    if (stopVerdict) {
      return { evt, verdict: stopVerdict, rewrittenLine: null };
    }
  } else if (Array.isArray(evt.choices) && evt.choices.length > 0) {
    // OpenAI / LiteLLM / Z.AI / Groq / OpenCode Chat Completions SSE (`object: "chat.completion.chunk"`)
    let bestVerdict = null;
    let rewrittenLine = null;
    let mutatedEvt = null;

    for (let cIdx = 0; cIdx < evt.choices.length; cIdx++) {
      if (bestVerdict && bestVerdict.decision === 'abort') break;
      const choice = evt.choices[cIdx] || {};
      const choiceOffset = (choice.index ?? cIdx) * 100;
      const d = choice.delta || {};

      // 1. Reasoning / thinking delta (`reasoning_content` or `reasoning`)
      const reasoningText = d.reasoning_content || d.reasoning || '';
      if (reasoningText) {
        const thinkIdx = choiceOffset + 0;
        if (!session.blocks.has(thinkIdx)) {
          session.onBlockStart({ index: thinkIdx, type: 'thinking' });
        }
        const v = session.onDelta({ index: thinkIdx, phase: 'thinking', delta: reasoningText });
        let effectiveText = reasoningText;
        if (v && v.decision === 'inject') {
          effectiveText = v.injectedText !== undefined ? v.injectedText : v.replacementDelta ?? reasoningText;
          mutatedEvt = mutatedEvt || structuredClone(evt);
          if (typeof mutatedEvt.choices[cIdx].delta.reasoning_content === 'string') {
            mutatedEvt.choices[cIdx].delta.reasoning_content = effectiveText;
          } else {
            mutatedEvt.choices[cIdx].delta.reasoning = effectiveText;
          }
        }
        if (onToken) {
          onToken({ phase: 'thinking', delta: effectiveText, rawDelta: reasoningText, index: thinkIdx, toolName: null, verdict: v });
        }
        bestVerdict = pickHigherVerdict(bestVerdict, v);
      }

      // 2. Visible text delta (`content`)
      const contentText = typeof d.content === 'string' ? d.content : '';
      if (contentText && (!bestVerdict || bestVerdict.decision !== 'abort')) {
        const textIdx = choiceOffset + 1;
        if (!session.blocks.has(textIdx)) {
          session.onBlockStart({ index: textIdx, type: 'text' });
        }
        const v = session.onDelta({ index: textIdx, phase: 'text', delta: contentText });
        let effectiveText = contentText;
        if (v && v.decision === 'inject') {
          effectiveText = v.injectedText !== undefined ? v.injectedText : v.replacementDelta ?? contentText;
          mutatedEvt = mutatedEvt || structuredClone(evt);
          mutatedEvt.choices[cIdx].delta.content = effectiveText;
        }
        if (onToken) {
          onToken({ phase: 'text', delta: effectiveText, rawDelta: contentText, index: textIdx, toolName: null, verdict: v });
        }
        bestVerdict = pickHigherVerdict(bestVerdict, v);
      }

      // 3. Tool-call arguments delta (`tool_calls[i].function.arguments`)
      if (Array.isArray(d.tool_calls) && (!bestVerdict || bestVerdict.decision !== 'abort')) {
        for (let i = 0; i < d.tool_calls.length; i++) {
          const tc = d.tool_calls[i];
          const blockIdx = choiceOffset + 10 + (tc.index ?? i);
          const fnName = tc.function?.name || null;
          if (!session.blocks.has(blockIdx) || fnName) {
            const existing = session.blocks.get(blockIdx);
            if (!existing) {
              session.onBlockStart({
                index: blockIdx,
                type: 'tool_use',
                toolName: fnName,
                toolId: tc.id || null,
              });
            } else if (fnName && !existing.toolName) {
              existing.toolName = fnName;
            }
          }
          const argsDelta = tc.function?.arguments || '';
          if (argsDelta) {
            const block = session.blocks.get(blockIdx);
            const v = session.onDelta({
              index: blockIdx,
              phase: 'tool_input',
              delta: argsDelta,
              toolName: block?.toolName || fnName,
            });
            let effectiveArgs = argsDelta;
            if (v && v.decision === 'inject') {
              effectiveArgs = v.injectedText !== undefined ? v.injectedText : v.replacementDelta ?? argsDelta;
              mutatedEvt = mutatedEvt || structuredClone(evt);
              mutatedEvt.choices[cIdx].delta.tool_calls[i].function.arguments = effectiveArgs;
            }
            if (onToken) {
              onToken({
                phase: 'tool_input',
                delta: effectiveArgs,
                rawDelta: argsDelta,
                index: blockIdx,
                toolName: block?.toolName || fnName,
                verdict: v,
              });
            }
            bestVerdict = pickHigherVerdict(bestVerdict, v);
          }
        }
      }

      // 4. Handle finish_reason block stop flush
      if (choice.finish_reason && (!bestVerdict || bestVerdict.decision !== 'abort') && typeof session.onBlockStop === 'function') {
        for (const idx of session.blocks.keys()) {
          if (Math.floor(idx / 100) === (choice.index ?? cIdx)) {
            const stopV = session.onBlockStop(idx);
            bestVerdict = pickHigherVerdict(bestVerdict, stopV);
          }
        }
      }
    }

    if (mutatedEvt) {
      evt = mutatedEvt;
      rewrittenLine = `data: ${JSON.stringify(evt)}`;
    }
    return { evt, verdict: bestVerdict, rewrittenLine };
  } else if (Array.isArray(evt.candidates) && evt.candidates.length > 0) {
    // Google Gemini GenerateContent SSE (`:streamGenerateContent?alt=sse`, `candidates[cIdx].content.parts[]`)
    let bestVerdict = null;
    let rewrittenLine = null;
    let mutatedEvt = null;

    for (let cIdx = 0; cIdx < evt.candidates.length; cIdx++) {
      if (bestVerdict && bestVerdict.decision === 'abort') break;
      const cand = evt.candidates[cIdx] || {};
      const candOffset = (cand.index ?? cIdx) * 100;
      const parts = Array.isArray(cand.content?.parts) ? cand.content.parts : [];

      for (let pIdx = 0; pIdx < parts.length; pIdx++) {
        if (bestVerdict && bestVerdict.decision === 'abort') break;
        const part = parts[pIdx];
        if (!part || typeof part !== 'object') continue;

        if (part.thought === true && typeof part.text === 'string' && part.text.length > 0) {
          const thinkIdx = candOffset + 0;
          if (!session.blocks.has(thinkIdx)) {
            session.onBlockStart({ index: thinkIdx, type: 'thinking' });
          }
          const v = session.onDelta({ index: thinkIdx, phase: 'thinking', delta: part.text });
          let effectiveText = part.text;
          if (v && v.decision === 'inject') {
            effectiveText = v.injectedText !== undefined ? v.injectedText : v.replacementDelta ?? part.text;
            mutatedEvt = mutatedEvt || structuredClone(evt);
            mutatedEvt.candidates[cIdx].content.parts[pIdx].text = effectiveText;
          }
          if (onToken) {
            onToken({ phase: 'thinking', delta: effectiveText, rawDelta: part.text, index: thinkIdx, toolName: null, verdict: v });
          }
          bestVerdict = pickHigherVerdict(bestVerdict, v);
        } else if (typeof part.text === 'string' && part.text.length > 0) {
          const textIdx = candOffset + 1;
          if (!session.blocks.has(textIdx)) {
            session.onBlockStart({ index: textIdx, type: 'text' });
          }
          const v = session.onDelta({ index: textIdx, phase: 'text', delta: part.text });
          let effectiveText = part.text;
          if (v && v.decision === 'inject') {
            effectiveText = v.injectedText !== undefined ? v.injectedText : v.replacementDelta ?? part.text;
            mutatedEvt = mutatedEvt || structuredClone(evt);
            mutatedEvt.candidates[cIdx].content.parts[pIdx].text = effectiveText;
          }
          if (onToken) {
            onToken({ phase: 'text', delta: effectiveText, rawDelta: part.text, index: textIdx, toolName: null, verdict: v });
          }
          bestVerdict = pickHigherVerdict(bestVerdict, v);
        } else if (part.functionCall) {
          const blockIdx = candOffset + 20 + pIdx;
          const fnName = part.functionCall.name || null;
          if (!session.blocks.has(blockIdx)) {
            session.onBlockStart({ index: blockIdx, type: 'tool_use', toolName: fnName, toolId: part.functionCall.id || null });
          }
          const argsStr =
            typeof part.functionCall.args === 'string'
              ? part.functionCall.args
              : JSON.stringify(part.functionCall.args || {});
          if (argsStr) {
            const v = session.onDelta({ index: blockIdx, phase: 'tool_input', delta: argsStr, toolName: fnName });
            let effectiveArgs = argsStr;
            if (v && v.decision === 'inject') {
              effectiveArgs = v.injectedText !== undefined ? v.injectedText : v.replacementDelta ?? argsStr;
              mutatedEvt = mutatedEvt || structuredClone(evt);
              try {
                mutatedEvt.candidates[cIdx].content.parts[pIdx].functionCall.args = JSON.parse(effectiveArgs);
              } catch {
                mutatedEvt.candidates[cIdx].content.parts[pIdx].functionCall.args = effectiveArgs;
              }
            }
            if (onToken) {
              onToken({ phase: 'tool_input', delta: effectiveArgs, rawDelta: argsStr, index: blockIdx, toolName: fnName, verdict: v });
            }
            bestVerdict = pickHigherVerdict(bestVerdict, v);
          }
        }
      }

      if (cand.finishReason && (!bestVerdict || bestVerdict.decision !== 'abort') && typeof session.onBlockStop === 'function') {
        for (const idx of session.blocks.keys()) {
          if (Math.floor(idx / 100) === (cand.index ?? cIdx)) {
            const stopV = session.onBlockStop(idx);
            bestVerdict = pickHigherVerdict(bestVerdict, stopV);
          }
        }
      }
    }

    if (mutatedEvt) {
      evt = mutatedEvt;
      rewrittenLine = `data: ${JSON.stringify(evt)}`;
    }
    return { evt, verdict: bestVerdict, rewrittenLine };
  }

  return { evt, verdict: null, rewrittenLine: null };
}

/**
 * Async version of `evaluateSSELine` for sessions with async `tier2`, `tier3`, or `handler` rules.
 */
export async function evaluateSSELineAsync(line, session, onToken = null) {
  if (!session || typeof session.onDeltaAsync !== 'function') {
    return evaluateSSELine(line, session, onToken);
  }
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return { evt: null, verdict: null, rewrittenLine: null };
  const jsonStr = trimmed.slice(5).trim();
  if (!jsonStr || jsonStr === '[DONE]') return { evt: null, verdict: null, rewrittenLine: null };

  let evt;
  try {
    evt = JSON.parse(jsonStr);
  } catch {
    return { evt: null, verdict: null, rewrittenLine: null };
  }

  const callBlockStop = async (idx) => {
    if (typeof session.onBlockStopAsync === 'function') return session.onBlockStopAsync(idx);
    if (typeof session.onBlockStop === 'function') return session.onBlockStop(idx);
    return null;
  };

  if (evt.type === 'content_block_start' && evt.content_block) {
    const cb = evt.content_block;
    session.onBlockStart({
      index: evt.index ?? 0,
      type: cb.type,
      toolName: cb.name || null,
      toolId: cb.id || null,
    });
  } else if (evt.type === 'content_block_delta' && evt.delta) {
    const d = evt.delta;
    const index = evt.index ?? 0;
    let phase = null;
    let deltaText = '';

    if (d.type === 'thinking_delta') {
      phase = 'thinking';
      deltaText = d.thinking || '';
    } else if (d.type === 'text_delta') {
      phase = 'text';
      deltaText = d.text || '';
    } else if (d.type === 'input_json_delta') {
      phase = 'tool_input';
      deltaText = d.partial_json || '';
    }

    if (phase && deltaText) {
      const block = session.blocks.get(index);
      const verdict = await session.onDeltaAsync({
        index,
        phase,
        delta: deltaText,
        toolName: block?.toolName || null,
      });

      let rewrittenLine = null;
      let effectiveOutText = deltaText;
      if (verdict && verdict.decision === 'inject') {
        effectiveOutText =
          verdict.injectedText !== undefined
            ? verdict.injectedText
            : verdict.replacementDelta ?? deltaText;
        evt = setDeltaPayloadText(evt, effectiveOutText, 0, phase);
        rewrittenLine = `data: ${JSON.stringify(evt)}`;
      }

      if (onToken) {
        onToken({
          phase,
          delta: effectiveOutText,
          rawDelta: deltaText,
          index,
          toolName: block?.toolName || null,
          verdict,
        });
      }

      return { evt, verdict, rewrittenLine };
    }
  } else if (evt.type === 'content_block_stop') {
    const stopVerdict = await callBlockStop(evt.index ?? 0);
    if (stopVerdict) {
      return { evt, verdict: stopVerdict, rewrittenLine: null };
    }
  } else if (Array.isArray(evt.choices) && evt.choices.length > 0) {
    let bestVerdict = null;
    let rewrittenLine = null;
    let mutatedEvt = null;

    for (let cIdx = 0; cIdx < evt.choices.length; cIdx++) {
      if (bestVerdict && bestVerdict.decision === 'abort') break;
      const choice = evt.choices[cIdx] || {};
      const choiceOffset = (choice.index ?? cIdx) * 100;
      const d = choice.delta || {};

      const reasoningText = d.reasoning_content || d.reasoning || '';
      if (reasoningText) {
        const thinkIdx = choiceOffset + 0;
        if (!session.blocks.has(thinkIdx)) {
          session.onBlockStart({ index: thinkIdx, type: 'thinking' });
        }
        const v = await session.onDeltaAsync({ index: thinkIdx, phase: 'thinking', delta: reasoningText });
        let effectiveText = reasoningText;
        if (v && v.decision === 'inject') {
          effectiveText = v.injectedText !== undefined ? v.injectedText : v.replacementDelta ?? reasoningText;
          mutatedEvt = mutatedEvt || structuredClone(evt);
          if (typeof mutatedEvt.choices[cIdx].delta.reasoning_content === 'string') {
            mutatedEvt.choices[cIdx].delta.reasoning_content = effectiveText;
          } else {
            mutatedEvt.choices[cIdx].delta.reasoning = effectiveText;
          }
        }
        if (onToken) {
          onToken({ phase: 'thinking', delta: effectiveText, rawDelta: reasoningText, index: thinkIdx, toolName: null, verdict: v });
        }
        bestVerdict = pickHigherVerdict(bestVerdict, v);
      }

      const contentText = typeof d.content === 'string' ? d.content : '';
      if (contentText && (!bestVerdict || bestVerdict.decision !== 'abort')) {
        const textIdx = choiceOffset + 1;
        if (!session.blocks.has(textIdx)) {
          session.onBlockStart({ index: textIdx, type: 'text' });
        }
        const v = await session.onDeltaAsync({ index: textIdx, phase: 'text', delta: contentText });
        let effectiveText = contentText;
        if (v && v.decision === 'inject') {
          effectiveText = v.injectedText !== undefined ? v.injectedText : v.replacementDelta ?? contentText;
          mutatedEvt = mutatedEvt || structuredClone(evt);
          mutatedEvt.choices[cIdx].delta.content = effectiveText;
        }
        if (onToken) {
          onToken({ phase: 'text', delta: effectiveText, rawDelta: contentText, index: textIdx, toolName: null, verdict: v });
        }
        bestVerdict = pickHigherVerdict(bestVerdict, v);
      }

      if (Array.isArray(d.tool_calls) && (!bestVerdict || bestVerdict.decision !== 'abort')) {
        for (let i = 0; i < d.tool_calls.length; i++) {
          const tc = d.tool_calls[i];
          const blockIdx = choiceOffset + 10 + (tc.index ?? i);
          const fnName = tc.function?.name || null;
          if (!session.blocks.has(blockIdx) || fnName) {
            const existing = session.blocks.get(blockIdx);
            if (!existing) {
              session.onBlockStart({
                index: blockIdx,
                type: 'tool_use',
                toolName: fnName,
                toolId: tc.id || null,
              });
            } else if (fnName && !existing.toolName) {
              existing.toolName = fnName;
            }
          }
          const argsDelta = tc.function?.arguments || '';
          if (argsDelta) {
            const block = session.blocks.get(blockIdx);
            const v = await session.onDeltaAsync({
              index: blockIdx,
              phase: 'tool_input',
              delta: argsDelta,
              toolName: block?.toolName || fnName,
            });
            let effectiveArgs = argsDelta;
            if (v && v.decision === 'inject') {
              effectiveArgs = v.injectedText !== undefined ? v.injectedText : v.replacementDelta ?? argsDelta;
              mutatedEvt = mutatedEvt || structuredClone(evt);
              mutatedEvt.choices[cIdx].delta.tool_calls[i].function.arguments = effectiveArgs;
            }
            if (onToken) {
              onToken({
                phase: 'tool_input',
                delta: effectiveArgs,
                rawDelta: argsDelta,
                index: blockIdx,
                toolName: block?.toolName || fnName,
                verdict: v,
              });
            }
            bestVerdict = pickHigherVerdict(bestVerdict, v);
          }
        }
      }

      if (choice.finish_reason && (!bestVerdict || bestVerdict.decision !== 'abort')) {
        for (const idx of session.blocks.keys()) {
          if (Math.floor(idx / 100) === (choice.index ?? cIdx)) {
            const stopV = await callBlockStop(idx);
            bestVerdict = pickHigherVerdict(bestVerdict, stopV);
          }
        }
      }
    }

    if (mutatedEvt) {
      evt = mutatedEvt;
      rewrittenLine = `data: ${JSON.stringify(evt)}`;
    }
    return { evt, verdict: bestVerdict, rewrittenLine };
  } else if (Array.isArray(evt.candidates) && evt.candidates.length > 0) {
    let bestVerdict = null;
    let rewrittenLine = null;
    let mutatedEvt = null;

    for (let cIdx = 0; cIdx < evt.candidates.length; cIdx++) {
      if (bestVerdict && bestVerdict.decision === 'abort') break;
      const cand = evt.candidates[cIdx] || {};
      const candOffset = (cand.index ?? cIdx) * 100;
      const parts = Array.isArray(cand.content?.parts) ? cand.content.parts : [];

      for (let pIdx = 0; pIdx < parts.length; pIdx++) {
        if (bestVerdict && bestVerdict.decision === 'abort') break;
        const part = parts[pIdx];
        if (!part || typeof part !== 'object') continue;

        if (part.thought === true && typeof part.text === 'string' && part.text.length > 0) {
          const thinkIdx = candOffset + 0;
          if (!session.blocks.has(thinkIdx)) {
            session.onBlockStart({ index: thinkIdx, type: 'thinking' });
          }
          const v = await session.onDeltaAsync({ index: thinkIdx, phase: 'thinking', delta: part.text });
          let effectiveText = part.text;
          if (v && v.decision === 'inject') {
            effectiveText = v.injectedText !== undefined ? v.injectedText : v.replacementDelta ?? part.text;
            mutatedEvt = mutatedEvt || structuredClone(evt);
            mutatedEvt.candidates[cIdx].content.parts[pIdx].text = effectiveText;
          }
          if (onToken) {
            onToken({ phase: 'thinking', delta: effectiveText, rawDelta: part.text, index: thinkIdx, toolName: null, verdict: v });
          }
          bestVerdict = pickHigherVerdict(bestVerdict, v);
        } else if (typeof part.text === 'string' && part.text.length > 0) {
          const textIdx = candOffset + 1;
          if (!session.blocks.has(textIdx)) {
            session.onBlockStart({ index: textIdx, type: 'text' });
          }
          const v = await session.onDeltaAsync({ index: textIdx, phase: 'text', delta: part.text });
          let effectiveText = part.text;
          if (v && v.decision === 'inject') {
            effectiveText = v.injectedText !== undefined ? v.injectedText : v.replacementDelta ?? part.text;
            mutatedEvt = mutatedEvt || structuredClone(evt);
            mutatedEvt.candidates[cIdx].content.parts[pIdx].text = effectiveText;
          }
          if (onToken) {
            onToken({ phase: 'text', delta: effectiveText, rawDelta: part.text, index: textIdx, toolName: null, verdict: v });
          }
          bestVerdict = pickHigherVerdict(bestVerdict, v);
        } else if (part.functionCall) {
          const blockIdx = candOffset + 20 + pIdx;
          const fnName = part.functionCall.name || null;
          if (!session.blocks.has(blockIdx)) {
            session.onBlockStart({ index: blockIdx, type: 'tool_use', toolName: fnName, toolId: part.functionCall.id || null });
          }
          const argsStr =
            typeof part.functionCall.args === 'string'
              ? part.functionCall.args
              : JSON.stringify(part.functionCall.args || {});
          if (argsStr) {
            const v = await session.onDeltaAsync({ index: blockIdx, phase: 'tool_input', delta: argsStr, toolName: fnName });
            let effectiveArgs = argsStr;
            if (v && v.decision === 'inject') {
              effectiveArgs = v.injectedText !== undefined ? v.injectedText : v.replacementDelta ?? argsStr;
              mutatedEvt = mutatedEvt || structuredClone(evt);
              try {
                mutatedEvt.candidates[cIdx].content.parts[pIdx].functionCall.args = JSON.parse(effectiveArgs);
              } catch {
                mutatedEvt.candidates[cIdx].content.parts[pIdx].functionCall.args = effectiveArgs;
              }
            }
            if (onToken) {
              onToken({ phase: 'tool_input', delta: effectiveArgs, rawDelta: argsStr, index: blockIdx, toolName: fnName, verdict: v });
            }
            bestVerdict = pickHigherVerdict(bestVerdict, v);
          }
        }
      }

      if (cand.finishReason && (!bestVerdict || bestVerdict.decision !== 'abort')) {
        for (const idx of session.blocks.keys()) {
          if (Math.floor(idx / 100) === (cand.index ?? cIdx)) {
            const stopV = await callBlockStop(idx);
            bestVerdict = pickHigherVerdict(bestVerdict, stopV);
          }
        }
      }
    }

    if (mutatedEvt) {
      evt = mutatedEvt;
      rewrittenLine = `data: ${JSON.stringify(evt)}`;
    }
    return { evt, verdict: bestVerdict, rewrittenLine };
  }

  return { evt, verdict: null, rewrittenLine: null };
}

/**
 * Synthesizes clean Anthropic Messages SSE termination frames when a stream is
 * aborted mid-generation by a Midstream Hook.
 */
export function buildSyntheticAbortSSE(
  verdict,
  { openBlockIndex = 0, injectNoticeAsText = true, blockWasHeldBack = false } = {}
) {
  const frames = [];

  if (!blockWasHeldBack) {
    frames.push(
      `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: openBlockIndex })}\n\n`
    );
  }

  if (injectNoticeAsText && verdict?.additionalContext) {
    const noticeIndex = blockWasHeldBack ? openBlockIndex : openBlockIndex + 1;
    frames.push(
      `event: content_block_start\ndata: ${JSON.stringify({
        type: 'content_block_start',
        index: noticeIndex,
        content_block: { type: 'text', text: '' },
      })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        index: noticeIndex,
        delta: {
          type: 'text_delta',
          text: `\n\n[MIDSTREAM HOOK INTERVENTION: ${verdict.ruleId}]\n${verdict.additionalContext}\n`,
        },
      })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: noticeIndex })}\n\n`
    );
  }

  frames.push(
    `event: message_delta\ndata: ${JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 0 },
    })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`
  );

  return frames.join('');
}

function trimTrailingCharsFromHeldBackFrames(
  entries,
  charsToTrim,
  shiftEventIndexFn = null,
  targetPhase = null,
  targetBlockIndex = null
) {
  let remaining = charsToTrim;
  for (let i = entries.length - 1; i >= 0 && remaining > 0; i--) {
    const entry = entries[i];
    if (
      !entry.evt ||
      (entry.evt.type !== 'content_block_delta' &&
        !Array.isArray(entry.evt.choices) &&
        !Array.isArray(entry.evt.candidates))
    ) {
      continue;
    }
    const text = getDeltaPayloadText(entry.evt, targetPhase, targetBlockIndex);
    if (!text) continue;
    if (text.length <= remaining) {
      remaining -= text.length;
      entry.evt = setDeltaPayloadText(entry.evt, '', 0, targetPhase, targetBlockIndex);
      const rawLine = `data: ${JSON.stringify(entry.evt)}`;
      entry.dataLine = shiftEventIndexFn ? shiftEventIndexFn(entry.evt, rawLine) : rawLine;
    } else {
      const trimmedText = text.slice(0, text.length - remaining);
      remaining = 0;
      entry.evt = setDeltaPayloadText(entry.evt, trimmedText, 0, targetPhase, targetBlockIndex);
      const rawLine = `data: ${JSON.stringify(entry.evt)}`;
      entry.dataLine = shiftEventIndexFn ? shiftEventIndexFn(entry.evt, rawLine) : rawLine;
    }
  }
}

function serializeFrameEntry(entry) {
  let out = '';
  if (entry.eventLine !== null && entry.eventLine !== undefined) {
    out += `${entry.eventLine}\n`;
  }
  out += `${entry.dataLine}\n\n`;
  return out;
}

/**
 * Detects whether a visible-text or thinking rolling window ends with an incomplete prefix or body of any active
 * rule pattern (derived dynamically from `session.rules[i].pendingPrefixRegex`, such as
 * `ghp_[A-Za-z0-9]{12,}`, `github_pat_[A-Za-z0-9_]{20,}`, `sk-ant-api03-[A-Za-z0-9_-]{8,}`,
 * `sk-proj-[A-Za-z0-9_-]{20,}`, `AKIA[0-9A-Z]{12,}`, or custom rules like `xoxb-[0-9A-Za-z-]{10,}`).
 * While this returns true, the SSE interceptor holds back only the in-flight prefix chunks
 * (without delaying ordinary visible text) until the token completes or breaks the pattern.
 */
function hasPendingSecretPrefixInWindow(rollingWindow, rules = [], phase = 'text') {
  if (!rollingWindow) return false;
  const tail = String(rollingWindow).slice(-140);
  if (Array.isArray(rules) && rules.length > 0) {
    let checkedRuleRegex = false;
    for (const rule of rules) {
      if (rule?.phases && typeof rule.phases.has === 'function' && !rule.phases.has(phase)) continue;
      if (rule?.pendingPrefixRegex instanceof RegExp) {
        checkedRuleRegex = true;
        if (rule.pendingPrefixRegex.test(tail)) return true;
      }
    }
    if (checkedRuleRegex) return false;
  }
  if (/(?:^|[^A-Za-z0-9_-])(?:g|gh|ghp|ghs|gho|ghu|ghr|github|github_|github_p|github_pa|github_pat|s|sk|sk-|sk-a|sk-an|sk-ant|sk-ant-|sk-ant-a|sk-ant-ap|sk-ant-api|sk-ant-api0|sk-p|sk-pr|sk-pro|sk-proj|sk_|sk_l|sk_li|sk_liv|sk_live|A|AK|AKI|AS|ASI|AI|AIz|x|xo|xox)$/.test(tail)) {
    return true;
  }
  if (/\b(?:gh[pousr]_[A-Za-z0-9]{0,60}|github_pat_[A-Za-z0-9_]{0,90}|sk-ant-(?:api03-)?[A-Za-z0-9_-]{0,120}|sk-proj-[A-Za-z0-9_-]{0,120}|sk_live_[0-9A-Za-z]{0,90}|(?:AKIA|ASIA)[0-9A-Z]{0,32}|xox[baprs]-[0-9A-Za-z-]{0,90}|AIza[0-9A-Za-z_-]{0,45})$/.test(tail)) {
    return true;
  }
  return false;
}

export function isBlockPendingHoldback(block, rules) {
  if (!block) return false;
  if (block.hasDeferredMatch) return true;
  if (block.phase === 'text' || block.phase === 'thinking') {
    return hasPendingSecretPrefixInWindow(block.rollingWindow, rules, block.phase);
  }
  return false;
}

/**
 * Stateful SSE chunk interceptor for HTTP reverse proxies (like `anthropic-proxy.js`).
 */
export function createMidstreamSSEInterceptor({
  session,
  onForward,
  onAbort,
  onInStreamRetry = null,
  holdVisibleTextForRetry = false,
  onAsk,
  injectNoticeAsText = true,
  holdbackChunks = null,
  isContinuationStream = false,
  blockIndexOffset = 0,
}) {
  const decoder = new StringDecoder('utf8');
  let sseBuffer = '';
  let aborted = false;
  let pendingEventLine = null;
  let pendingDataParts = [];

  const maxRuleHoldback =
    holdbackChunks !== null
      ? Number(holdbackChunks)
      : Math.max(0, ...(session?.rules || []).map((r) => Number(r.holdbackChunks) || 0));

  const heldToolBlocks = new Map();
  const slidingHoldbackQueues = new Map();
  const preCommitBuffer = [];
  let turnCommitted = !onInStreamRetry;
  let detectedStreamFormat = 'anthropic';

  const hasAsyncRules = Boolean(
    session &&
      Array.isArray(session.rules) &&
      session.rules.some((r) => r && (r.tier2 || r.tier3 || r.handler))
  );

  function emitDownstream(str) {
    if (!onForward) return;
    if (!turnCommitted) {
      preCommitBuffer.push(str);
    } else {
      onForward(str);
    }
  }

  function commitTurnAndFlush() {
    if (turnCommitted) return;
    turnCommitted = true;
    while (preCommitBuffer.length > 0) {
      const s = preCommitBuffer.shift();
      if (onForward) onForward(s);
    }
  }

  function shiftEventIndex(evtObj, rawDataLine) {
    if (!blockIndexOffset || !evtObj || typeof evtObj.index !== 'number') return rawDataLine;
    const shifted = { ...evtObj, index: evtObj.index + blockIndexOffset };
    return `data: ${JSON.stringify(shifted)}`;
  }

  function flushSlidingQueue(index) {
    const q = slidingHoldbackQueues.get(index);
    if (!q || q.length === 0) return;
    while (q.length > 0) {
      const entry = q.shift();
      emitDownstream(serializeFrameEntry(entry));
    }
  }

  function flushAllSlidingQueues() {
    for (const index of slidingHoldbackQueues.keys()) {
      flushSlidingQueue(index);
    }
  }

  function trimAndFlushSlidingQueueOnAbort(index, verdict) {
    let q = slidingHoldbackQueues.get(index);
    if ((!q || q.length === 0) && slidingHoldbackQueues.size > 0) {
      for (const candidateQ of slidingHoldbackQueues.values()) {
        if (candidateQ && candidateQ.length > 0) {
          q = candidateQ;
          break;
        }
      }
    }
    if (!q || q.length === 0) return;
    if (verdict && verdict.spanPrefixCharsInPrevChunks > 0) {
      trimTrailingCharsFromHeldBackFrames(
        q,
        verdict.spanPrefixCharsInPrevChunks,
        shiftEventIndex,
        verdict.phase,
        verdict.blockIndex ?? index
      );
    }
    flushSlidingQueue(index);
  }

  function applyStopInjectToQueue(q, stopV) {
    if (!q || q.length === 0) return;
    if (stopV.spanPrefixCharsInPrevChunks > 0) {
      trimTrailingCharsFromHeldBackFrames(
        q,
        stopV.spanPrefixCharsInPrevChunks,
        shiftEventIndex,
        stopV.phase,
        stopV.blockIndex
      );
    }
    const lastEntry = q[q.length - 1];
    const prevText = getDeltaPayloadText(lastEntry.evt, stopV.phase, stopV.blockIndex);
    lastEntry.evt = setDeltaPayloadText(
      lastEntry.evt,
      prevText + (stopV.injectedText ?? ''),
      0,
      stopV.phase,
      stopV.blockIndex
    );
    lastEntry.dataLine = shiftEventIndex(lastEntry.evt, `data: ${JSON.stringify(lastEntry.evt)}`);
  }

  function triggerAbort(verdict, blockIndex, isHeldToolBlock, triggeringFrameEntry = null) {
    aborted = true;
    if (isHeldToolBlock) {
      heldToolBlocks.delete(blockIndex);
    } else {
      trimAndFlushSlidingQueueOnAbort(blockIndex, verdict);
    }
    if (onInStreamRetry && !turnCommitted) {
      preCommitBuffer.length = 0;
      heldToolBlocks.clear();
      slidingHoldbackQueues.clear();
      onInStreamRetry(verdict, session.getSummaryMetrics(), {
        nextBlockIndexOffset: 0,
        prefillText: verdict?.prefillText || '',
      });
      return;
    }
    flushAllSlidingQueues();
    commitTurnAndFlush();
    if (!isHeldToolBlock && triggeringFrameEntry && verdict && typeof verdict.safeDeltaPrefix === 'string' && verdict.safeDeltaPrefix.length > 0) {
      const safeEvt = setDeltaPayloadText(triggeringFrameEntry.evt, verdict.safeDeltaPrefix, 0, verdict.phase);
      const safeLine = shiftEventIndex(safeEvt, `data: ${JSON.stringify(safeEvt)}`);
      emitDownstream(
        serializeFrameEntry({
          eventLine: triggeringFrameEntry.eventLine,
          dataLine: safeLine,
          evt: safeEvt,
        })
      );
    }
    if (detectedStreamFormat === 'openai') {
      if (injectNoticeAsText && verdict?.additionalContext) {
        const noticeChunk = {
          id: 'midstream-abort',
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: 'midstream-proxy',
          choices: [
            {
              index: 0,
              delta: {
                content: `\n\n[MIDSTREAM HOOK INTERVENTION: ${verdict.ruleId}]\n${verdict.additionalContext}\n`,
              },
              finish_reason: 'stop',
            },
          ],
        };
        emitDownstream(`data: ${JSON.stringify(noticeChunk)}\n\n`);
      }
      emitDownstream('data: [DONE]\n\n');
    } else if (detectedStreamFormat === 'gemini') {
      if (injectNoticeAsText && verdict?.additionalContext) {
        const noticeChunk = {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    text: `\n\n[MIDSTREAM HOOK INTERVENTION: ${verdict.ruleId}]\n${verdict.additionalContext}\n`,
                  },
                ],
              },
              finishReason: 'STOP',
              index: 0,
            },
          ],
          modelVersion: 'midstream-proxy',
        };
        emitDownstream(`data: ${JSON.stringify(noticeChunk)}\n\n`);
      }
    } else {
      const syntheticTail = buildSyntheticAbortSSE(verdict, {
        openBlockIndex: blockIndex + blockIndexOffset,
        injectNoticeAsText,
        blockWasHeldBack: isHeldToolBlock,
      });
      emitDownstream(syntheticTail);
    }
    if (onAbort) onAbort(verdict, session.getSummaryMetrics());
  }

  function handleEvaluatedDataLine(rawLine, eventLine, { evt, verdict: initialVerdict, rewrittenLine }, askResolution = undefined) {
    let verdict = initialVerdict;
    if (evt) {
      if (Array.isArray(evt.choices)) detectedStreamFormat = 'openai';
      else if (Array.isArray(evt.candidates)) detectedStreamFormat = 'gemini';
    }
    const effectiveDataLine = shiftEventIndex(evt, rewrittenLine || rawLine);

    if (!evt) {
      if (eventLine !== null) emitDownstream(`${eventLine}\n`);
      emitDownstream(`${effectiveDataLine}\n\n`);
      return;
    }

    if (isContinuationStream && evt.type === 'message_start') {
      return;
    }

    const blockIndex = evt.index ?? 0;

    // 1. Handle `content_block_start`
    if (evt.type === 'content_block_start' && evt.content_block) {
      if (evt.content_block.type === 'tool_use') {
        heldToolBlocks.set(blockIndex, [
          { eventLine: eventLine ?? 'event: content_block_start', dataLine: effectiveDataLine, evt },
        ]);
        return;
      }
      if (evt.content_block.type === 'text' && !holdVisibleTextForRetry) {
        commitTurnAndFlush();
      }
      if (eventLine !== null) emitDownstream(`${eventLine}\n`);
      emitDownstream(`${effectiveDataLine}\n\n`);
      return;
    }

    // 2. Handle `content_block_delta`
    if (evt.type === 'content_block_delta') {
      const isHeldToolBlock = heldToolBlocks.has(blockIndex);
      const frameEntry = {
        eventLine: eventLine ?? 'event: content_block_delta',
        dataLine: effectiveDataLine,
        evt,
      };

      if (verdict && verdict.decision === 'ask' && onAsk) {
        const askRes = askResolution !== undefined ? askResolution : onAsk(verdict, session.getSummaryMetrics());
        if (
          askRes === false ||
          (askRes && typeof askRes === 'object' && (askRes.decision === 'abort' || askRes.decision === 'block' || askRes.decision === 'deny'))
        ) {
          triggerAbort({ ...verdict, decision: 'abort' }, blockIndex, isHeldToolBlock, frameEntry);
          return;
        }
      }

      if (verdict && verdict.decision === 'abort') {
        triggerAbort(verdict, blockIndex, isHeldToolBlock, frameEntry);
        return;
      }

      if (isHeldToolBlock) {
        const toolFrames = heldToolBlocks.get(blockIndex);
        if (verdict && verdict.decision === 'inject' && verdict.spanPrefixCharsInPrevChunks > 0) {
          trimTrailingCharsFromHeldBackFrames(toolFrames, verdict.spanPrefixCharsInPrevChunks, shiftEventIndex, verdict.phase);
        }
        toolFrames.push(frameEntry);
        return;
      }

      const currentBlock = session.blocks.get(blockIndex);
      const pendingHoldback = isBlockPendingHoldback(currentBlock, session.rules);

      if (maxRuleHoldback > 0 || pendingHoldback) {
        let q = slidingHoldbackQueues.get(blockIndex);
        if (!q) {
          q = [];
          slidingHoldbackQueues.set(blockIndex, q);
        }
        if (verdict && verdict.decision === 'inject' && verdict.spanPrefixCharsInPrevChunks > 0) {
          trimTrailingCharsFromHeldBackFrames(q, verdict.spanPrefixCharsInPrevChunks, shiftEventIndex, verdict.phase);
        }
        q.push(frameEntry);
        if (!pendingHoldback) {
          while (q.length > maxRuleHoldback) {
            const ready = q.shift();
            emitDownstream(serializeFrameEntry(ready));
          }
        }
        return;
      }

      flushSlidingQueue(blockIndex);
      emitDownstream(serializeFrameEntry(frameEntry));
      return;
    }

    // 3. Handle `content_block_stop`
    if (evt.type === 'content_block_stop') {
      const isHeldToolBlock = heldToolBlocks.has(blockIndex);
      if (verdict && verdict.decision === 'abort') {
        triggerAbort(verdict, blockIndex, isHeldToolBlock);
        return;
      }
      if (isHeldToolBlock) {
        const toolFrames = heldToolBlocks.get(blockIndex);
        if (verdict && verdict.decision === 'inject') {
          applyStopInjectToQueue(toolFrames, verdict);
        }
        heldToolBlocks.delete(blockIndex);
        for (const entry of toolFrames) {
          emitDownstream(serializeFrameEntry(entry));
        }
      } else {
        const q = slidingHoldbackQueues.get(blockIndex);
        if (verdict && verdict.decision === 'inject') {
          applyStopInjectToQueue(q, verdict);
        }
        flushSlidingQueue(blockIndex);
      }
      if (eventLine !== null) emitDownstream(`${eventLine}\n`);
      emitDownstream(`${effectiveDataLine}\n\n`);
      return;
    }

    // 4. OpenAI / LiteLLM `chat.completion.chunk` (`evt.choices`)
    if (Array.isArray(evt.choices)) {
      const choice = evt.choices[0] || {};
      const d = choice.delta || {};
      const isToolCallChunk = evt.choices.some((c) => Array.isArray(c?.delta?.tool_calls) && c.delta.tool_calls.length > 0);
      const hasVisibleContent = evt.choices.some((c) => typeof c?.delta?.content === 'string' && c.delta.content.length > 0);
      const hasFinishReason = evt.choices.some((c) => Boolean(c?.finish_reason));
      let defaultOpenAiBlockIdx = isToolCallChunk
        ? 10 + (d.tool_calls?.[0]?.index ?? 0)
        : hasVisibleContent
          ? 1
          : d.reasoning_content || d.reasoning
            ? 0
            : 1;
      if (!isToolCallChunk) {
        const activeChoiceIdx = evt.choices.findIndex(
          (c) =>
            (typeof c?.delta?.content === 'string' && c.delta.content.length > 0) ||
            Boolean(c?.delta?.reasoning_content || c?.delta?.reasoning)
        );
        if (activeChoiceIdx >= 0) {
          const ac = evt.choices[activeChoiceIdx];
          const offset = (ac?.index ?? activeChoiceIdx) * 100;
          defaultOpenAiBlockIdx =
            typeof ac?.delta?.content === 'string' && ac.delta.content.length > 0 ? offset + 1 : offset + 0;
        }
      }
      const openAiBlockIdx =
        verdict && typeof verdict.blockIndex === 'number' ? verdict.blockIndex : defaultOpenAiBlockIdx;

      if (verdict && verdict.decision === 'ask' && onAsk) {
        const askRes = askResolution !== undefined ? askResolution : onAsk(verdict, session.getSummaryMetrics());
        if (
          askRes === false ||
          (askRes && typeof askRes === 'object' && (askRes.decision === 'abort' || askRes.decision === 'block' || askRes.decision === 'deny'))
        ) {
          verdict = {
            ...verdict,
            decision: 'abort',
            additionalContext: (askRes && askRes.additionalContext) || verdict.additionalContext,
          };
        }
      }
      if (verdict && verdict.decision === 'abort') {
        aborted = true;
        heldToolBlocks.delete(openAiBlockIdx);
        if (onInStreamRetry && !turnCommitted) {
          preCommitBuffer.length = 0;
          heldToolBlocks.clear();
          slidingHoldbackQueues.clear();
          onInStreamRetry(verdict, session.getSummaryMetrics(), { nextBlockIndexOffset: 0 });
          return;
        }
        trimAndFlushSlidingQueueOnAbort(openAiBlockIdx, verdict);
        flushAllSlidingQueues();
        commitTurnAndFlush();
        if (!isToolCallChunk && typeof verdict.safeDeltaPrefix === 'string' && verdict.safeDeltaPrefix.length > 0) {
          const safeEvt = setDeltaPayloadText(evt, verdict.safeDeltaPrefix, 0, verdict.phase, openAiBlockIdx);
          emitDownstream(
            serializeFrameEntry({
              eventLine,
              dataLine: `data: ${JSON.stringify(safeEvt)}`,
              evt: safeEvt,
            })
          );
        }
        if (injectNoticeAsText && verdict.additionalContext) {
          const noticeChunk = {
            id: evt.id || 'midstream-abort',
            object: 'chat.completion.chunk',
            created: evt.created || Math.floor(Date.now() / 1000),
            model: evt.model || 'midstream-proxy',
            choices: [
              {
                index: 0,
                delta: {
                  content: `\n\n[MIDSTREAM HOOK INTERVENTION: ${verdict.ruleId}]\n${verdict.additionalContext}\n`,
                },
                finish_reason: 'stop',
              },
            ],
          };
          emitDownstream(`data: ${JSON.stringify(noticeChunk)}\n\n`);
        }
        emitDownstream('data: [DONE]\n\n');
        if (onAbort) onAbort(verdict, session.getSummaryMetrics());
        return;
      }

      if (hasVisibleContent && !holdVisibleTextForRetry) {
        commitTurnAndFlush();
      }

      const frameEntry = {
        eventLine,
        dataLine: effectiveDataLine,
        evt,
      };

      if (isToolCallChunk) {
        let toolFrames = heldToolBlocks.get(openAiBlockIdx);
        if (!toolFrames) {
          toolFrames = [];
          heldToolBlocks.set(openAiBlockIdx, toolFrames);
        }
        if (verdict && verdict.decision === 'inject' && verdict.spanPrefixCharsInPrevChunks > 0) {
          trimTrailingCharsFromHeldBackFrames(
            toolFrames,
            verdict.spanPrefixCharsInPrevChunks,
            shiftEventIndex,
            verdict.phase,
            openAiBlockIdx
          );
        }
        toolFrames.push(frameEntry);
        if (hasFinishReason) {
          commitTurnAndFlush();
          for (const [k, tf] of heldToolBlocks.entries()) {
            heldToolBlocks.delete(k);
            for (const entry of tf) {
              emitDownstream(serializeFrameEntry(entry));
            }
          }
        }
        return;
      }

      if (hasFinishReason) {
        commitTurnAndFlush();
        for (const [k, toolFrames] of heldToolBlocks.entries()) {
          if (verdict && verdict.decision === 'inject') {
            applyStopInjectToQueue(toolFrames, verdict);
          }
          heldToolBlocks.delete(k);
          for (const entry of toolFrames) {
            emitDownstream(serializeFrameEntry(entry));
          }
        }
        for (const q of slidingHoldbackQueues.values()) {
          if (verdict && verdict.decision === 'inject') {
            applyStopInjectToQueue(q, verdict);
          }
        }
        flushAllSlidingQueues();
        emitDownstream(serializeFrameEntry(frameEntry));
        return;
      }

      let pendingOpenAiHoldback = false;
      for (const blk of session.blocks.values()) {
        if (isBlockPendingHoldback(blk, session.rules)) {
          pendingOpenAiHoldback = true;
          break;
        }
      }

      if (maxRuleHoldback > 0 || pendingOpenAiHoldback) {
        let q = slidingHoldbackQueues.get(openAiBlockIdx);
        if (!q) {
          q = [];
          slidingHoldbackQueues.set(openAiBlockIdx, q);
        }
        if (verdict && verdict.decision === 'inject' && verdict.spanPrefixCharsInPrevChunks > 0) {
          trimTrailingCharsFromHeldBackFrames(
            q,
            verdict.spanPrefixCharsInPrevChunks,
            shiftEventIndex,
            verdict.phase,
            openAiBlockIdx
          );
        }
        q.push(frameEntry);
        if (!pendingOpenAiHoldback) {
          while (q.length > maxRuleHoldback) {
            const ready = q.shift();
            emitDownstream(serializeFrameEntry(ready));
          }
        }
        return;
      }

      flushAllSlidingQueues();
      emitDownstream(serializeFrameEntry(frameEntry));
      return;
    }

    // 4b. Google Gemini `:streamGenerateContent?alt=sse` (`evt.candidates`)
    if (Array.isArray(evt.candidates)) {
      const cand = evt.candidates[0] || {};
      const parts = Array.isArray(cand.content?.parts) ? cand.content.parts : [];
      const hasVisibleText = evt.candidates.some((c) =>
        Array.isArray(c?.content?.parts) && c.content.parts.some((p) => p && !p.thought && typeof p.text === 'string' && p.text.length > 0)
      );
      const hasThought = evt.candidates.some((c) =>
        Array.isArray(c?.content?.parts) && c.content.parts.some((p) => p && p.thought === true && typeof p.text === 'string' && p.text.length > 0)
      );
      const hasFunctionCall = evt.candidates.some((c) =>
        Array.isArray(c?.content?.parts) && c.content.parts.some((p) => p && p.functionCall)
      );
      const hasFinishReason = evt.candidates.some((c) => Boolean(c?.finishReason));
      let defaultGeminiBlockIdx = hasFunctionCall ? 20 : hasVisibleText ? 1 : hasThought ? 0 : 1;
      if (!hasFunctionCall) {
        const activeCandIdx = evt.candidates.findIndex(
          (c) =>
            Array.isArray(c?.content?.parts) &&
            c.content.parts.some((p) => p && typeof p.text === 'string' && p.text.length > 0)
        );
        if (activeCandIdx >= 0) {
          const ac = evt.candidates[activeCandIdx];
          const offset = (ac?.index ?? activeCandIdx) * 100;
          const isVis = ac.content.parts.some((p) => p && !p.thought && typeof p.text === 'string' && p.text.length > 0);
          defaultGeminiBlockIdx = isVis ? offset + 1 : offset + 0;
        }
      }
      const geminiBlockIdx =
        verdict && typeof verdict.blockIndex === 'number' ? verdict.blockIndex : defaultGeminiBlockIdx;

      if (verdict && verdict.decision === 'ask' && onAsk) {
        const askRes = askResolution !== undefined ? askResolution : onAsk(verdict, session.getSummaryMetrics());
        if (
          askRes === false ||
          (askRes && typeof askRes === 'object' && (askRes.decision === 'abort' || askRes.decision === 'block' || askRes.decision === 'deny'))
        ) {
          verdict = {
            ...verdict,
            decision: 'abort',
            additionalContext: (askRes && askRes.additionalContext) || verdict.additionalContext,
          };
        }
      }

      if (verdict && verdict.decision === 'abort') {
        aborted = true;
        heldToolBlocks.delete(geminiBlockIdx);
        if (onInStreamRetry && !turnCommitted) {
          preCommitBuffer.length = 0;
          heldToolBlocks.clear();
          slidingHoldbackQueues.clear();
          onInStreamRetry(verdict, session.getSummaryMetrics(), { nextBlockIndexOffset: 0 });
          return;
        }
        trimAndFlushSlidingQueueOnAbort(geminiBlockIdx, verdict);
        flushAllSlidingQueues();
        commitTurnAndFlush();
        if (!hasFunctionCall && typeof verdict.safeDeltaPrefix === 'string' && verdict.safeDeltaPrefix.length > 0) {
          const safeEvt = setDeltaPayloadText(evt, verdict.safeDeltaPrefix, 0, verdict.phase, geminiBlockIdx);
          emitDownstream(
            serializeFrameEntry({
              eventLine,
              dataLine: `data: ${JSON.stringify(safeEvt)}`,
              evt: safeEvt,
            })
          );
        }
        if (injectNoticeAsText && verdict.additionalContext) {
          const noticeChunk = {
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [
                    {
                      text: `\n\n[MIDSTREAM HOOK INTERVENTION: ${verdict.ruleId}]\n${verdict.additionalContext}\n`,
                    },
                  ],
                },
                finishReason: 'STOP',
                index: 0,
              },
            ],
            modelVersion: evt.modelVersion || 'midstream-proxy',
          };
          emitDownstream(`data: ${JSON.stringify(noticeChunk)}\n\n`);
        }
        if (onAbort) onAbort(verdict, session.getSummaryMetrics());
        return;
      }

      if (hasVisibleText && !holdVisibleTextForRetry) {
        commitTurnAndFlush();
      }

      const frameEntry = {
        eventLine,
        dataLine: effectiveDataLine,
        evt,
      };

      if (hasFinishReason) {
        commitTurnAndFlush();
        for (const q of slidingHoldbackQueues.values()) {
          if (verdict && verdict.decision === 'inject') {
            applyStopInjectToQueue(q, verdict);
          }
        }
        flushAllSlidingQueues();
        emitDownstream(serializeFrameEntry(frameEntry));
        return;
      }

      let pendingGeminiHoldback = false;
      for (const blk of session.blocks.values()) {
        if (isBlockPendingHoldback(blk, session.rules)) {
          pendingGeminiHoldback = true;
          break;
        }
      }

      if (maxRuleHoldback > 0 || pendingGeminiHoldback) {
        let q = slidingHoldbackQueues.get(geminiBlockIdx);
        if (!q) {
          q = [];
          slidingHoldbackQueues.set(geminiBlockIdx, q);
        }
        if (verdict && verdict.decision === 'inject' && verdict.spanPrefixCharsInPrevChunks > 0) {
          trimTrailingCharsFromHeldBackFrames(
            q,
            verdict.spanPrefixCharsInPrevChunks,
            shiftEventIndex,
            verdict.phase,
            geminiBlockIdx
          );
        }
        q.push(frameEntry);
        if (!pendingGeminiHoldback) {
          while (q.length > maxRuleHoldback) {
            const ready = q.shift();
            emitDownstream(serializeFrameEntry(ready));
          }
        }
        return;
      }

      flushAllSlidingQueues();
      emitDownstream(serializeFrameEntry(frameEntry));
      return;
    }

    // 5. All other SSE events (`message_start`, `message_delta`, `message_stop`, `ping`)
    if (evt.type === 'message_delta' || evt.type === 'message_stop') {
      if (evt.type === 'message_stop') {
        commitTurnAndFlush();
      }
      flushAllSlidingQueues();
    }
    if (eventLine !== null) emitDownstream(`${eventLine}\n`);
    emitDownstream(`${effectiveDataLine}\n\n`);
  }

  function resolveCompleteDataLine(rawLine, nextLines) {
    const trimmed = rawLine.trim();
    const payload = trimmed.slice(5).trim();
    if (pendingDataParts.length === 0) {
      if (!payload || payload === '[DONE]') return rawLine;
      try {
        JSON.parse(payload);
        return rawLine;
      } catch {
        // Check if subsequent lines in this or future chunks continue a multi-line `data:` event
        pendingDataParts.push(payload);
        return null;
      }
    } else {
      pendingDataParts.push(payload);
      const joined = pendingDataParts.join('\n');
      try {
        JSON.parse(joined);
        pendingDataParts = [];
        return `data: ${joined}`;
      } catch {
        // Still incomplete unless the next line is blank
        if (nextLines.length > 0 && nextLines[0].trim() === '') {
          pendingDataParts = [];
          return `data: ${joined}`;
        }
        return null;
      }
    }
  }

  return {
    hasAsyncRules,
    push(chunk) {
      if (aborted) return;
      sseBuffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() || '';

      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        if (aborted) return;
        const rawLine = lines[lineIdx];
        const trimmed = rawLine.trim();

        if (trimmed.startsWith('event:')) {
          pendingEventLine = rawLine;
          continue;
        }

        if (trimmed === '') {
          if (pendingDataParts.length > 0) {
            const joinedLine = `data: ${pendingDataParts.join('\n')}`;
            pendingDataParts = [];
            const eventLine = pendingEventLine;
            pendingEventLine = null;
            const evalRes = evaluateSSELine(joinedLine, session);
            handleEvaluatedDataLine(joinedLine, eventLine, evalRes);
            continue;
          }
          if (pendingEventLine !== null) {
            emitDownstream(`${pendingEventLine}\n\n`);
            pendingEventLine = null;
          }
          continue;
        }

        if (!trimmed.startsWith('data:')) {
          if (pendingEventLine !== null) {
            emitDownstream(`${pendingEventLine}\n`);
            pendingEventLine = null;
          }
          emitDownstream(`${rawLine}\n`);
          continue;
        }

        const completeDataLine = resolveCompleteDataLine(rawLine, lines.slice(lineIdx + 1));
        if (completeDataLine === null) {
          continue;
        }

        const eventLine = pendingEventLine;
        pendingEventLine = null;

        const evalRes = evaluateSSELine(completeDataLine, session);
        if (!evalRes.evt && completeDataLine.includes('[DONE]')) {
          if (session && typeof session.onBlockStop === 'function') {
            for (const idx of session.blocks.keys()) {
              const stopV = session.onBlockStop(idx);
              if (stopV && stopV.decision === 'abort') {
                triggerAbort(stopV, idx, heldToolBlocks.has(idx));
                return;
              }
              if (stopV && stopV.decision === 'inject') {
                applyStopInjectToQueue(slidingHoldbackQueues.get(idx), stopV);
              }
            }
          }
          flushAllSlidingQueues();
          commitTurnAndFlush();
          emitDownstream(`${completeDataLine}\n\n`);
          continue;
        }

        handleEvaluatedDataLine(completeDataLine, eventLine, evalRes);
      }
    },
    async pushAsync(chunk) {
      if (aborted) return;
      sseBuffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() || '';

      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        if (aborted) return;
        const rawLine = lines[lineIdx];
        const trimmed = rawLine.trim();

        if (trimmed.startsWith('event:')) {
          pendingEventLine = rawLine;
          continue;
        }

        if (trimmed === '') {
          if (pendingDataParts.length > 0) {
            const joinedLine = `data: ${pendingDataParts.join('\n')}`;
            pendingDataParts = [];
            const eventLine = pendingEventLine;
            pendingEventLine = null;
            const evalRes = await evaluateSSELineAsync(joinedLine, session);
            let askRes = undefined;
            if (evalRes.verdict && evalRes.verdict.decision === 'ask' && onAsk) {
              askRes = await onAsk(evalRes.verdict, session.getSummaryMetrics());
            }
            handleEvaluatedDataLine(joinedLine, eventLine, evalRes, askRes);
            continue;
          }
          if (pendingEventLine !== null) {
            emitDownstream(`${pendingEventLine}\n\n`);
            pendingEventLine = null;
          }
          continue;
        }

        if (!trimmed.startsWith('data:')) {
          if (pendingEventLine !== null) {
            emitDownstream(`${pendingEventLine}\n`);
            pendingEventLine = null;
          }
          emitDownstream(`${rawLine}\n`);
          continue;
        }

        const completeDataLine = resolveCompleteDataLine(rawLine, lines.slice(lineIdx + 1));
        if (completeDataLine === null) {
          continue;
        }

        const eventLine = pendingEventLine;
        pendingEventLine = null;

        const evalRes = await evaluateSSELineAsync(completeDataLine, session);
        if (!evalRes.evt && completeDataLine.includes('[DONE]')) {
          if (session) {
            for (const idx of session.blocks.keys()) {
              const stopV =
                typeof session.onBlockStopAsync === 'function'
                  ? await session.onBlockStopAsync(idx)
                  : typeof session.onBlockStop === 'function'
                    ? session.onBlockStop(idx)
                    : null;
              if (stopV && stopV.decision === 'abort') {
                triggerAbort(stopV, idx, heldToolBlocks.has(idx));
                return;
              }
              if (stopV && stopV.decision === 'inject') {
                applyStopInjectToQueue(slidingHoldbackQueues.get(idx), stopV);
              }
            }
          }
          flushAllSlidingQueues();
          commitTurnAndFlush();
          emitDownstream(`${completeDataLine}\n\n`);
          continue;
        }

        let askRes = undefined;
        if (evalRes.verdict && evalRes.verdict.decision === 'ask' && onAsk) {
          askRes = await onAsk(evalRes.verdict, session.getSummaryMetrics());
        }
        handleEvaluatedDataLine(completeDataLine, eventLine, evalRes, askRes);
      }
    },
    end() {
      if (aborted) return;
      const tail = decoder.end();
      if (tail) sseBuffer += tail;
      if (sseBuffer.trim().length > 0 || pendingDataParts.length > 0) {
        this.push('\n\n');
        if (aborted) return;
      }
      if (session && typeof session.onBlockStop === 'function') {
        for (const [idx] of session.blocks.entries()) {
          const stopV = session.onBlockStop(idx);
          if (stopV && stopV.decision === 'abort') {
            triggerAbort(stopV, idx, heldToolBlocks.has(idx));
            return;
          }
          if (stopV && stopV.decision === 'inject') {
            applyStopInjectToQueue(slidingHoldbackQueues.get(idx), stopV);
          }
        }
      }
      commitTurnAndFlush();
      for (const [k, toolFrames] of heldToolBlocks.entries()) {
        heldToolBlocks.delete(k);
        for (const entry of toolFrames) {
          emitDownstream(serializeFrameEntry(entry));
        }
      }
      flushAllSlidingQueues();
      if (pendingEventLine !== null) {
        emitDownstream(`${pendingEventLine}\n`);
        pendingEventLine = null;
      }
      if (sseBuffer) {
        emitDownstream(sseBuffer);
        sseBuffer = '';
      }
    },
    async endAsync() {
      if (aborted) return;
      const tail = decoder.end();
      if (tail) sseBuffer += tail;
      if (sseBuffer.trim().length > 0 || pendingDataParts.length > 0) {
        await this.pushAsync('\n\n');
        if (aborted) return;
      }
      if (session) {
        for (const [idx] of session.blocks.entries()) {
          const stopV =
            typeof session.onBlockStopAsync === 'function'
              ? await session.onBlockStopAsync(idx)
              : typeof session.onBlockStop === 'function'
                ? session.onBlockStop(idx)
                : null;
          if (stopV && stopV.decision === 'abort') {
            triggerAbort(stopV, idx, heldToolBlocks.has(idx));
            return;
          }
          if (stopV && stopV.decision === 'inject') {
            applyStopInjectToQueue(slidingHoldbackQueues.get(idx), stopV);
          }
        }
      }
      commitTurnAndFlush();
      for (const [k, toolFrames] of heldToolBlocks.entries()) {
        heldToolBlocks.delete(k);
        for (const entry of toolFrames) {
          emitDownstream(serializeFrameEntry(entry));
        }
      }
      flushAllSlidingQueues();
      if (pendingEventLine !== null) {
        emitDownstream(`${pendingEventLine}\n`);
        pendingEventLine = null;
      }
      if (sseBuffer) {
        emitDownstream(sseBuffer);
        sseBuffer = '';
      }
    },
  };
}

/**
 * Client-side SSE consumer with native `AbortController.abort()` trigger.
 */
export async function consumeSSEWithMidstreamHooks({
  response,
  abortController,
  session,
  onToken = null,
  onAsk = null,
}) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let usage = null;
  let stopReason = null;
  let model = null;

  async function processLine(line) {
    const { evt, verdict } = await evaluateSSELineAsync(line, session, onToken);
    if (evt) {
      if (evt.type === 'message_start' && evt.message) {
        model = evt.message.model || model;
        if (evt.message.usage) usage = { ...(usage || {}), ...evt.message.usage };
      } else if (evt.type === 'message_delta') {
        if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
        if (evt.usage) usage = { ...(usage || {}), ...evt.usage };
      } else if (Array.isArray(evt.choices)) {
        model = evt.model || model;
        if (evt.choices[0]?.finish_reason) stopReason = evt.choices[0].finish_reason;
        if (evt.usage) usage = { ...(usage || {}), ...evt.usage };
      } else if (Array.isArray(evt.candidates)) {
        model = evt.modelVersion || model;
        if (evt.candidates[0]?.finishReason) stopReason = evt.candidates[0].finishReason;
        if (evt.usageMetadata) usage = { ...(usage || {}), ...evt.usageMetadata };
      }
    }

    if (verdict && verdict.decision === 'ask' && onAsk) {
      const askRes = await onAsk(verdict, session.getSummaryMetrics());
      if (
        askRes === false ||
        (askRes && typeof askRes === 'object' && (askRes.decision === 'abort' || askRes.decision === 'block' || askRes.decision === 'deny'))
      ) {
        const abortVerdict = { ...verdict, decision: 'abort' };
        abortController.abort(abortVerdict);
        return {
          aborted: true,
          verdict: abortVerdict,
          model,
          stopReason: 'midstream_hook_abort',
          usage,
          blocks: [...session.blocks.values()],
          metrics: session.getSummaryMetrics(),
        };
      }
    }

    if (verdict && verdict.decision === 'abort') {
      abortController.abort(verdict);
      return {
        aborted: true,
        verdict,
        model,
        stopReason: 'midstream_hook_abort',
        usage,
        blocks: [...session.blocks.values()],
        metrics: session.getSummaryMetrics(),
      };
    }

    return null;
  }

  try {
    for await (const rawChunk of response.body) {
      buffer += decoder.write(Buffer.from(rawChunk));
      let nlIdx;
      while ((nlIdx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nlIdx);
        buffer = buffer.slice(nlIdx + 1);
        const earlyReturn = await processLine(line);
        if (earlyReturn) return earlyReturn;
      }
    }
    buffer += decoder.end();
    if (buffer.trim().length > 0) {
      const earlyReturn = await processLine(buffer);
      if (earlyReturn) return earlyReturn;
    }
    if (session) {
      for (const idx of session.blocks.keys()) {
        const stopV =
          typeof session.onBlockStopAsync === 'function'
            ? await session.onBlockStopAsync(idx)
            : typeof session.onBlockStop === 'function'
              ? session.onBlockStop(idx)
              : null;
        if (stopV && stopV.decision === 'abort') {
          abortController.abort(stopV);
          return {
            aborted: true,
            verdict: stopV,
            model,
            stopReason: 'midstream_hook_abort',
            usage,
            blocks: [...session.blocks.values()],
            metrics: session.getSummaryMetrics(),
          };
        }
      }
    }
  } catch (err) {
    if (err?.isStreamTimeout || abortController?.signal?.reason?.isStreamTimeout) {
      throw err;
    }
    if (session.abortedVerdict || err?.name === 'AbortError') {
      return {
        aborted: true,
        verdict: session.abortedVerdict,
        model,
        stopReason: 'midstream_hook_abort',
        usage,
        blocks: [...session.blocks.values()],
        metrics: session.getSummaryMetrics(),
      };
    }
    throw err;
  }

  return {
    aborted: false,
    verdict: null,
    model,
    stopReason,
    usage,
    blocks: [...session.blocks.values()],
    metrics: session.getSummaryMetrics(),
  };
}
