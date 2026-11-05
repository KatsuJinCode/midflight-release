/**
 * Midflight / Midstream Deterministic Hook Engine (`src/engine.mjs`)
 *
 * Implements the standardized "During" hook call site (`DuringThinking`, `DuringText`, `DuringToolInput`).
 *
 * Supports three execution modes and four canonical hook decisions:
 * - `Slipstream` mode:
 *   - `allow` / `continue` : Observe/log or run side-effect code without interrupting.
 *   - `inject` / `rewrite` / `redact` : Transform, redact, or inject text directly into the token stream in flight.
 * - `Clearance` mode:
 *   - `ask`                : Pause / trigger a permission gate (`onAsk` can return `{ decision: 'abort' | 'allow' }`).
 * - `FlyByWire` mode:
 *   - `block` / `abort`    : Interrupt upstream generation immediately and inject policy context.
 *
 * Also supports:
 * - Semantic Acknowledgement Prefixes (`ackPrefix`, e.g. `deprecated:wrangler`)
 * - Automatic Self-Modeling Prompt Sanitization (`sanitizeInstructionWithPrefix`, `sanitizePromptForRule`, `sanitizeRequestMessages`)
 * - Multi-match / density thresholds (`minMatches`) for early topic-drift steering
 * - Token-boundary-aligned rolling windows (preventing left-edge prefix/word clipping false positives)
 * - Right-edge incomplete-word deferral (`deferIncompleteWords` + `onBlockStop`) so split words
 *   like `"pathogen"` + `"esis"` (`"pathogenesis"`) never false-positive on `\bpathogen\b`.
 */

export function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Self-Modeling Prompt Invariant:
 * Rewrites any unprefixed match of the target pattern inside a rule's own instruction
 * (`additionalContext` / `message`) so the instruction itself always models `<ackPrefix><token>`.
 */
export function sanitizeInstructionWithPrefix(text, unacknowledgedRegex, ackPrefix) {
  if (!text || !unacknowledgedRegex || !ackPrefix) return text || '';
  const flags = unacknowledgedRegex.flags.includes('g')
    ? unacknowledgedRegex.flags
    : unacknowledgedRegex.flags + 'g';
  const globalRegex = new RegExp(unacknowledgedRegex.source, flags);
  return String(text).replace(globalRegex, (match, ...args) => {
    const offset = typeof args[args.length - 2] === 'number' ? args[args.length - 2] : 0;
    const fullStr = typeof args[args.length - 1] === 'string' ? args[args.length - 1] : String(text);
    // Do not corrupt hyphenated rule identifiers like `cloudflare-no-wrangler` where `-` precedes a word-boundary match
    if (offset > 0 && fullStr[offset - 1] === '-' && !match.startsWith('-')) {
      return match;
    }
    return `${ackPrefix}${match}`;
  });
}

/**
 * Sanitizes a prompt or conversation message for a triggered rule before retrying:
 * - If the rule allows `<ackPrefix><token>` in `thinking`/`text`, rewrites bare matches to `<ackPrefix><match>`.
 * - If the rule forbids all occurrences (`allowAckIn.size === 0`, e.g. live secrets), replaces matches with `rule.promptReplacement`.
 */
export function sanitizePromptForRule(text, rule) {
  if (!text || !rule) return text || '';
  if (rule.ackPrefix && rule.allowAckIn && rule.allowAckIn.size > 0 && rule.unacknowledgedRegex) {
    return sanitizeInstructionWithPrefix(text, rule.unacknowledgedRegex, rule.ackPrefix);
  }
  if (rule.bareRegex && rule.promptReplacement) {
    const flags = rule.bareRegex.flags.includes('g') ? rule.bareRegex.flags : rule.bareRegex.flags + 'g';
    const globalBare = new RegExp(rule.bareRegex.source, flags);
    return String(text).replace(globalBare, rule.promptReplacement);
  }
  return text;
}

/**
 * Sanitizes an array of chat messages (or a serialized JSON request body) across a set of compiled rules
 * so multi-turn retries through an HTTP proxy or SDK wrapper do not leave bare unprefixed trigger words
 * or raw secrets inside prior conversation history (including `role: "tool"` and Anthropic `tool_result` blocks
 * by default so `Read`/`Grep` outputs do not recreate Condition 4b induction-head failures on Turn 2).
 */
export function sanitizeRequestMessages(messagesOrBody, rules = [], { includeToolResults = true } = {}) {
  const compiled = rules.length > 0 && rules[0]?._compiled === true ? rules : compileRules(rules);
  const sanitizeStr = (str) => {
    let out = String(str);
    for (const rule of compiled) {
      out = sanitizePromptForRule(out, rule);
    }
    return out;
  };

  if (typeof messagesOrBody === 'string') {
    try {
      const parsed = JSON.parse(messagesOrBody);
      if (Array.isArray(parsed.messages)) {
        parsed.messages = sanitizeRequestMessages(parsed.messages, compiled, { includeToolResults });
      }
      if (Array.isArray(parsed.contents)) {
        parsed.contents = parsed.contents.map((turn) => {
          if (!turn || typeof turn !== 'object' || !Array.isArray(turn.parts)) return turn;
          return {
            ...turn,
            parts: turn.parts.map((part) => {
              if (!part || typeof part !== 'object') return part;
              if (typeof part.text === 'string') {
                return { ...part, text: sanitizeStr(part.text) };
              }
              if (part.functionResponse && includeToolResults && part.functionResponse.response) {
                try {
                  const respStr = JSON.stringify(part.functionResponse.response);
                  return {
                    ...part,
                    functionResponse: {
                      ...part.functionResponse,
                      response: JSON.parse(sanitizeStr(respStr)),
                    },
                  };
                } catch {
                  return part;
                }
              }
              return part;
            }),
          };
        });
      }
      if (typeof parsed.system === 'string') {
        parsed.system = sanitizeStr(parsed.system);
      }
      if (parsed.systemInstruction && Array.isArray(parsed.systemInstruction.parts)) {
        parsed.systemInstruction = {
          ...parsed.systemInstruction,
          parts: parsed.systemInstruction.parts.map((p) =>
            p && typeof p.text === 'string' ? { ...p, text: sanitizeStr(p.text) } : p
          ),
        };
      }
      return JSON.stringify(parsed);
    } catch {
      return sanitizeStr(messagesOrBody);
    }
  }

  if (Array.isArray(messagesOrBody)) {
    return messagesOrBody.map((msg) => {
      if (!msg || typeof msg !== 'object') return msg;
      if (msg.role === 'tool' && !includeToolResults) return msg;
      const clone = { ...msg };
      if (typeof clone.content === 'string') {
        clone.content = sanitizeStr(clone.content);
      } else if (Array.isArray(clone.content)) {
        clone.content = clone.content.map((part) => {
          if (!part || typeof part !== 'object') return part;
          if (part.type === 'tool_result') {
            if (!includeToolResults) return part;
            if (typeof part.content === 'string') {
              return { ...part, content: sanitizeStr(part.content) };
            }
            if (Array.isArray(part.content)) {
              return {
                ...part,
                content: part.content.map((sub) =>
                  sub && typeof sub.text === 'string' ? { ...sub, text: sanitizeStr(sub.text) } : sub
                ),
              };
            }
            return part;
          }
          if (typeof part.text === 'string') {
            return { ...part, text: sanitizeStr(part.text) };
          }
          return part;
        });
      }
      return clone;
    });
  }

  return messagesOrBody;
}

/**
 * Constructs a self-healing Turn 2 request body for transparent in-stream proxy retry (`FlyByWire`).
 * Sanitizes existing messages specifically for the triggered rule via `sanitizeRequestMessages()`
 * and attaches the triggered rule's self-modeling `<system-reminder>` at the active generation frontier.
 */
export function buildRetryRequestBody(rawRequestBody, verdict, rules = []) {
  const compiled = rules.length > 0 && rules[0]?._compiled === true ? rules : compileRules(rules);
  const targetRules = verdict?.ruleId ? compiled.filter((r) => r.id === verdict.ruleId) : compiled;
  const activeRules = targetRules.length > 0 ? targetRules : compiled;
  const sanitizedJson = sanitizeRequestMessages(rawRequestBody, activeRules);
  try {
    const parsed = typeof sanitizedJson === 'string' ? JSON.parse(sanitizedJson) : structuredClone(sanitizedJson);
    const reminder = `\n\n<system-reminder>\n${verdict?.additionalContext || ''}\n</system-reminder>`;
    if (Array.isArray(parsed.messages) && parsed.messages.length > 0) {
      const lastMsg = parsed.messages[parsed.messages.length - 1];
      if (lastMsg && lastMsg.role === 'user') {
        if (typeof lastMsg.content === 'string') {
          lastMsg.content += reminder;
        } else if (Array.isArray(lastMsg.content)) {
          lastMsg.content.push({ type: 'text', text: reminder });
        }
      } else {
        // In OpenAI/Anthropic multi-step tool loops where the last message is `tool` or `assistant`,
        // append a fresh user message at the active generation frontier so the reminder is never buried.
        parsed.messages.push({
          role: 'user',
          content: `${reminder.trim()}\n\nExecute the required tool call now while strictly following the policy above.`,
        });
      }
    } else if (Array.isArray(parsed.contents) && parsed.contents.length > 0) {
      const lastTurn = parsed.contents[parsed.contents.length - 1];
      if (lastTurn && (lastTurn.role === 'user' || !lastTurn.role) && Array.isArray(lastTurn.parts)) {
        lastTurn.parts.push({ text: reminder });
      } else {
        parsed.contents.push({ role: 'user', parts: [{ text: reminder.trim() }] });
      }
    }
    return JSON.stringify(parsed);
  } catch {
    return typeof sanitizedJson === 'string' ? sanitizedJson : JSON.stringify(sanitizedJson);
  }
}

/**
 * Constructs a pre-seeded assistant continuation request body for APIs that support
 * assistant prefill (Anthropic Messages, OpenAI-compatible vLLM / SGLang / DeepSeek, and Gemini).
 * Appends `prefillText` as the pre-seeded opening of the assistant/model turn so the upstream
 * model continues generating from the corrected token sequence within one continuous client stream.
 */
export function buildPrefillContinuationBody(rawRequestBody, prefillTextOrVerdict, rules = [], options = {}) {
  const compiled = rules.length > 0 && rules[0]?._compiled === true ? rules : compileRules(rules);
  const sanitizedJson = sanitizeRequestMessages(rawRequestBody, compiled);
  const prefill =
    prefillTextOrVerdict && typeof prefillTextOrVerdict === 'object'
      ? String(prefillTextOrVerdict.prefillText ?? '')
      : String(prefillTextOrVerdict ?? '');
  const phase =
    options?.phase ||
    (prefillTextOrVerdict && typeof prefillTextOrVerdict === 'object' ? prefillTextOrVerdict.phase : null) ||
    'text';
  const vendor = String(options?.vendor || '').toLowerCase();
  const useVllmFlags = vendor === 'vllm' || vendor === 'sglang' || options?.continueFinalMessage === true;
  const useDeepSeekPrefix = vendor === 'deepseek' || options?.prefixFlag === true;
  try {
    const parsed = typeof sanitizedJson === 'string' ? JSON.parse(sanitizedJson) : structuredClone(sanitizedJson);
    if (Array.isArray(parsed.messages)) {
      const assistantMsg =
        phase === 'thinking'
          ? { role: 'assistant', content: '', reasoning_content: prefill }
          : { role: 'assistant', content: prefill };
      if (useDeepSeekPrefix) {
        assistantMsg.prefix = true;
      }
      const lastMsg = parsed.messages[parsed.messages.length - 1];
      if (lastMsg && lastMsg.role === 'assistant' && typeof lastMsg.content === 'string') {
        if (phase === 'thinking') {
          lastMsg.reasoning_content = prefill;
        } else {
          lastMsg.content = prefill;
        }
        if (useDeepSeekPrefix) lastMsg.prefix = true;
      } else {
        parsed.messages.push(assistantMsg);
      }
      if (useVllmFlags || parsed.continue_final_message !== undefined) {
        parsed.continue_final_message = true;
        parsed.add_generation_prompt = false;
      }
    } else if (Array.isArray(parsed.contents)) {
      const part = phase === 'thinking' ? { text: prefill, thought: true } : { text: prefill };
      parsed.contents.push({ role: 'model', parts: [part] });
    }
    return JSON.stringify(parsed);
  } catch {
    return typeof sanitizedJson === 'string' ? sanitizedJson : JSON.stringify(sanitizedJson);
  }
}

/**
 * Declarative helper for defining a Three-Tier Escalation Funnel rule:
 * - Tier 1 (`pattern` / `bareRegex`): ~1 µs in-memory lexical trigger on the rolling window
 * - Tier 2 (`tier2`): ~10–100 µs local structural/cluster check over the surrounding window (zero model cost)
 * - Tier 3 (`tier3`): millisecond semantic classifier / calibrated decision model (e.g. a calibrated System-1 classifier)
 */
export function createTieredSignalRule({
  id,
  phases = ['thinking', 'text', 'tool_input'],
  allowAckIn = ['thinking', 'text'],
  tools = null,
  pattern,
  ackPrefix = null,
  minMatches = 1,
  tier2 = null,
  tier3 = null,
  action = 'abort',
  replacement = undefined,
  additionalContext = '',
  permissionPrompt = null,
} = {}) {
  return {
    id,
    phases,
    allowAckIn,
    tools,
    pattern,
    ackPrefix,
    minMatches,
    tier2,
    tier3,
    action,
    replacement,
    additionalContext,
    permissionPrompt,
  };
}

/**
 * Built-in Tier 1 -> Tier 2 Early Syntax Validation Rule (`createEarlySyntaxValidationRule`):
 * - Tier 1 (`pattern`): triggers in microseconds whenever a statement or block closure (`;\n`, `}\n`)
 *   streams inside `tool_input` (`Write` / `Edit`).
 * - Tier 2 (`tier2`): performs a fast structural balanced-delimiter check over the completed
 *   statement/function prefix in `fullText` (ignoring string literals), halting the stream immediately
 *   when a closing delimiter `}`, `)`, or `]` is mismatched before the rest of a large file finishes streaming.
 */
export function createEarlySyntaxValidationRule({
  id = 'early-syntax-validation',
  tools = ['Write', 'Edit'],
  additionalContext = 'Early syntax validation detected an unbalanced or mismatched closing delimiter in your streamed code block. Fix the syntax error and regenerate.',
} = {}) {
  return createTieredSignalRule({
    id,
    phases: ['tool_input'],
    allowAckIn: [],
    tools,
    pattern: /[};)\]]\s*(?:\\n|\n|$)/,
    action: 'abort',
    additionalContext,
    tier2: ({ fullText, toolName }) => {
      const rawText = String(fullText || '');
      // Skip non-C-family / prose / config / shell / YAML files (`.md`, `.txt`, `.rst`, `.adoc`, `.yml`, `.yaml`, `.sh`, `.bash`, `.zsh`, `.fish`, `.toml`, `.ini`, `.cfg`, `.conf`, `.env`, `.sql`, `.html`, `.xml`, `.svg`, `.css`)
      if (
        /"(?:file_path|path)"\s*:\s*"[^"]+\.(?:md|txt|rst|adoc|yml|yaml|sh|bash|zsh|fish|ksh|toml|ini|cfg|conf|env|sql|html|xml|svg|css)"/i.test(
          rawText
        )
      ) {
        return false;
      }
      const isEditFragment =
        toolName === 'Edit' || /"(?:old_string|new_string)"\s*:/.test(rawText);

      // Extract the streamed code body from JSON `"content":"..."` / `"new_string":"..."` / `"old_string":"..."` if present
      const fieldMatch = rawText.match(/"(?:content|new_string|old_string)"\s*:\s*"((?:\\.|[^"\\])*)(?:"[\s\S]*)?$/);
      if (!fieldMatch && /^\s*\{/.test(rawText)) {
        // Still streaming JSON keys before `"content"` / `"new_string"` starts
        return false;
      }
      const rawBody = fieldMatch ? fieldMatch[1] : rawText;
      const codeBody = fieldMatch
        ? rawBody.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\')
        : rawText;

      // Skip shell scripts (`#!/bin/sh`, `case ... in`) and YAML documents (`---\n` or pure `key: value` blocks)
      if (
        /^#!.*\b(?:ba|z|da|k|fi)?sh\b/m.test(codeBody) ||
        /\bcase\s+[^\n;]+\s+in\b/.test(codeBody) ||
        /^---\s*\n/.test(codeBody) ||
        (/^[a-zA-Z0-9_.-]+:\s*(?:[|>][-+]?\s*)?(?:\n|$)/m.test(codeBody) && !/\b(?:function|const|let|var|class|import|export|return|if|for|while|fn|pub|struct|impl|def)\b/.test(codeBody))
      ) {
        return false;
      }

      const stack = [];
      const openToClose = { '{': '}', '(': ')', '[': ']' };
      const closeToOpen = { '}': '{', ')': '(', ']': '[' };
      let inStr = null;
      let inLineComment = false;
      let inBlockComment = false;
      let inRegex = false;
      let inRegexCharClass = false;
      let prevNonSpace = '';

      for (let i = 0; i < codeBody.length; i++) {
        const ch = codeBody[i];
        const next = codeBody[i + 1] || '';

        if (inLineComment) {
          if (ch === '\n') inLineComment = false;
          continue;
        }
        if (inBlockComment) {
          if (ch === '*' && next === '/') {
            inBlockComment = false;
            i += 1;
          }
          continue;
        }
        if (inRegex) {
          if (ch === '\\') {
            i += 1;
            continue;
          }
          if (inRegexCharClass) {
            if (ch === ']') inRegexCharClass = false;
            continue;
          }
          if (ch === '[') {
            inRegexCharClass = true;
            continue;
          }
          if (ch === '/' || ch === '\n') {
            inRegex = false;
            prevNonSpace = '/';
          }
          continue;
        }
        if (inStr) {
          if (ch === '\\') {
            i += 1;
            continue;
          }
          if (ch === inStr || (ch === '\n' && inStr !== '`')) {
            inStr = null;
            prevNonSpace = ch;
          }
          continue;
        }

        // Check comment starts (`//` or `/*`) outside strings
        if (ch === '/' && next === '/') {
          inLineComment = true;
          i += 1;
          continue;
        }
        if (ch === '/' && next === '*') {
          inBlockComment = true;
          i += 1;
          continue;
        }
        // Check regex literal start (`/pattern/`) when preceded by an expression-start token or keyword (`return`, `typeof`, `void`, `delete`, `in`, `instanceof`, `new`, `throw`, `yield`, `await`, `case`)
        if (ch === '/' && next !== '/' && next !== '*' && next !== '\n') {
          const prefixBeforeSlash = codeBody.slice(0, i);
          const afterExprKeyword = /(?:^|[^A-Za-z0-9_$])(?:return|typeof|void|delete|in|instanceof|new|throw|yield|await|case)\s*$/.test(
            prefixBeforeSlash
          );
          if (!prevNonSpace || /[=([{,;?:!&|+\-~^%<>]/.test(prevNonSpace) || afterExprKeyword) {
            inRegex = true;
            inRegexCharClass = false;
            continue;
          }
        }

        if (ch === '"' || ch === '`') {
          inStr = ch;
          continue;
        }
        if (ch === "'") {
          // Do not treat contraction apostrophes (`don't`, `it's`) or Rust lifetimes/labels (`&'a str`, `<'a>`, `'static`, `'outer: loop`) as opening a single-quoted string
          const prev = i > 0 ? codeBody[i - 1] : '';
          if (/[A-Za-z0-9_]/.test(prev) && /[A-Za-z0-9_]/.test(next)) {
            continue;
          }
          if (/^'[A-Za-z_][A-Za-z0-9_]*(?!')/.test(codeBody.slice(i))) {
            continue;
          }
          inStr = "'";
          continue;
        }

        if (!/\s/.test(ch)) {
          prevNonSpace = ch;
        }

        if (openToClose[ch]) {
          stack.push(ch);
        } else if (closeToOpen[ch]) {
          // Ignore markdown numbered-list markers like `1) install deps;` at line start when no `(` is open
          if (ch === ')' && (stack.length === 0 || stack[stack.length - 1] !== '(')) {
            const lineStart = codeBody.lastIndexOf('\n', i - 1) + 1;
            const prefixOnLine = codeBody.slice(lineStart, i);
            if (/^\s*\d+$/.test(prefixOnLine)) {
              continue;
            }
          }
          // In partial `Edit` replacement fragments, closing an outer block at `stack.length === 0` is valid;
          // only abort `Edit` when an opener inside the fragment is closed by a mismatched delimiter (e.g. `(1 + 2]`)!
          if (stack.length === 0 && isEditFragment) {
            continue;
          }
          if (stack.length === 0 || stack[stack.length - 1] !== closeToOpen[ch]) {
            return { decision: 'abort', additionalContext };
          }
          stack.pop();
        }
      }
      return false;
    },
  });
}

/**
 * Built-in Pre-Mutation Workspace Snapshot Rule (`createPreMutationSnapshotRule`):
 * - Watches `<thinking>` (or `tool_input`) for risky migration or destructive mutation signals
 *   and triggers a one-time workspace snapshot callback (`onSnapshot`) per `MidstreamSession`
 *   in `continue` (`Slipstream`) mode before any destructive edit or command executes.
 */
export function createPreMutationSnapshotRule({
  id = 'pre-mutation-workspace-snapshot',
  phases = ['thinking', 'tool_input'],
  pattern = /\b(?:schema\s+migration|database\s+migration|destructive\s+refactor|git\s+reset\s+--hard|DROP\s+TABLE|rm\s+-rf)\b/i,
  onSnapshot = null,
} = {}) {
  const takenSessions = new WeakSet();
  let fallbackTaken = false;
  return {
    id,
    phases,
    allowAckIn: [],
    pattern,
    action: 'continue',
    handler: (ctx) => {
      const sess = ctx?.session;
      const alreadyTaken = sess && typeof sess === 'object' ? takenSessions.has(sess) : fallbackTaken;
      if (!alreadyTaken) {
        if (sess && typeof sess === 'object') {
          takenSessions.add(sess);
        } else {
          fallbackTaken = true;
        }
        if (typeof onSnapshot === 'function') {
          onSnapshot(ctx);
        }
      }
      return { decision: 'allow' };
    },
  };
}

/**
 * Built-in Speculative Workspace Prefetch / Cache-Warming Rule (`createSpeculativePrefetchRule`):
 * - Watches `<thinking>` for natural workspace file paths (e.g. `src/auth.ts`, `tests/auth.test.ts`,
 *   `packages/core/index.ts`) or explicit `[PREFETCH:...]` tags and invokes `onPrefetch(filePath, ctx)`
 *   in `continue` (`Slipstream`) mode without interrupting generation.
 * - Uses `deferIncompleteWords: true` and per-session path deduplication so split paths like
 *   `"src/auth.t"` + `"s"` wait until the path token finishes before firing `onPrefetch("src/auth.ts")`.
 */
export function createSpeculativePrefetchRule({
  id = 'speculative-workspace-prefetch',
  pattern = /\b(?:src|lib|tests?|docs|bin|packages)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+\b|\[PREFETCH:([A-Za-z0-9_./-]+)\]/,
  onPrefetch = null,
} = {}) {
  const seenBySession = new WeakMap();
  const fallbackSeen = new Set();
  return {
    id,
    phases: ['thinking'],
    allowAckIn: [],
    deferIncompleteWords: true,
    pattern,
    action: 'continue',
    handler: (ctx) => {
      const m = String(ctx.matchedText || '').match(/^\[PREFETCH:(.+)\]$/) || [null, ctx.matchedText];
      const targetPath = m[1] || ctx.matchedText;
      const sess = ctx?.session;
      let seenPaths = fallbackSeen;
      if (sess && typeof sess === 'object') {
        seenPaths = seenBySession.get(sess);
        if (!seenPaths) {
          seenPaths = new Set();
          seenBySession.set(sess, seenPaths);
        }
      }
      if (targetPath && !seenPaths.has(targetPath)) {
        seenPaths.add(targetPath);
        if (typeof onPrefetch === 'function') {
          onPrefetch(targetPath, ctx);
        }
      }
      return { decision: 'allow' };
    },
  };
}

const ACTION_TO_DECISION = {
  continue: 'allow',
  allow: 'allow',
  observe: 'allow',
  warn: 'allow',
  slipstream: 'inject',
  inject: 'inject',
  rewrite: 'inject',
  redact: 'inject',
  clearance: 'ask',
  ask: 'ask',
  permission_request: 'ask',
  'fly-by-wire': 'abort',
  flybywire: 'abort',
  block: 'abort',
  deny: 'abort',
  abort: 'abort',
};

const DECISION_SEVERITY = {
  allow: 0,
  inject: 1,
  ask: 2,
  abort: 3,
};

/**
 * Extracts literal or character-class prefix + quantified character-class branches
 * (e.g. `ghp_[A-Za-z0-9]{12,}`, `xox[bp]-[0-9A-Za-z-]{12,}`, `sk_live_[0-9a-zA-Z]{24}`,
 * `AIza[0-9A-Za-z_-]{35}`, `AKIA[0-9A-Z]{12,}`) from a rule's regex source and builds a
 * trailing-window matcher that returns true whenever a visible-text rolling window ends with
 * an in-progress prefix or body of that pattern.
 */
function buildPendingPrefixRegexFromSource(rawSource, baseFlags = '') {
  if (!rawSource || typeof rawSource !== 'string') return null;
  const cleanedSource = rawSource.replace(/\\[bB]/g, ' ');
  // Matches a prefix (2+ literal chars optionally containing a character class like `xox[bp]-`)
  // followed by a character class `[...]` and a quantifier `{min}`, `{min,}`, or `{min,max}` (or `+`).
  const branchRe =
    /([A-Za-z0-9_-]{2,}(?:\[(?:\\\]|[^\]])+\][A-Za-z0-9_-]*)?)\s*(\[(?:\\\]|[^\]])+\])\s*(?:\{\s*(\d+)\s*(?:,\s*(\d*)\s*)?\}|\+)/g;
  const partialPrefixes = new Set();
  const bodyHoldbacks = [];
  let m;
  while ((m = branchRe.exec(cleanedSource)) !== null) {
    const rawPrefix = m[1];
    const charClass = m[2];
    const minQuant = m[3] ? Number(m[3]) : 1;
    const maxQuantStr = m[4];
    const maxQuant =
      maxQuantStr !== undefined && maxQuantStr !== ''
        ? Math.min(200, Math.max(32, Number(maxQuantStr) + 16))
        : m[3] && maxQuantStr === undefined
          ? Math.min(200, Math.max(32, minQuant + 16))
          : 120;
    const leadingLiteralMatch = rawPrefix.match(/^[A-Za-z0-9_-]+/);
    const leadingLiteral = leadingLiteralMatch ? leadingLiteralMatch[0] : '';
    if (leadingLiteral.length < 2) continue;
    for (let len = 1; len < leadingLiteral.length; len++) {
      partialPrefixes.add(leadingLiteral.slice(0, len).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    }
    if (rawPrefix !== leadingLiteral) {
      // Also hold back when the leading literal is complete (`xox`) or inside the prefix class (`xoxb`, `xoxp`)
      partialPrefixes.add(leadingLiteral.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const prefixWithoutTrailingPunct = rawPrefix.replace(/[-_]+$/, '');
      if (prefixWithoutTrailingPunct && prefixWithoutTrailingPunct !== rawPrefix) {
        partialPrefixes.add(prefixWithoutTrailingPunct);
      }
    }
    bodyHoldbacks.push(`${rawPrefix}${charClass}{0,${maxQuant}}`);
  }
  if (bodyHoldbacks.length === 0) return null;
  const parts = [];
  if (partialPrefixes.size > 0) {
    parts.push(`(?:^|[^A-Za-z0-9_-])(?:${[...partialPrefixes].join('|')})$`);
  }
  parts.push(`\\b(?:${bodyHoldbacks.join('|')})$`);
  try {
    return new RegExp(`(?:${parts.join('|')})`, baseFlags.includes('i') ? 'i' : '');
  } catch {
    return null;
  }
}

/**
 * Compiles declarative and functional hook definitions.
 * Safe and idempotent when passed already-compiled rules.
 */
export function compileRules(rules = []) {
  return rules.map((r) => {
    if (
      r &&
      r._compiled === true &&
      r.pendingPrefixRegex !== undefined &&
      r.hasTrailingCharClassQuantifier !== undefined &&
      r.hasTrailingNegativeLookahead !== undefined
    ) {
      return r;
    }
    const rawPattern = r.pattern ?? r.bareRegex ?? null;
    const rawSource =
      typeof r.rawSource === 'string'
        ? r.rawSource
        : rawPattern instanceof RegExp
          ? rawPattern.source
          : rawPattern
            ? String(rawPattern)
            : null;
    const baseFlags = (
      typeof r.baseFlags === 'string'
        ? r.baseFlags
        : rawPattern instanceof RegExp
          ? rawPattern.flags
          : (r.flags ?? 'i')
    ).replace(/g/g, '');

    const ackPrefix = r.ackPrefix || null;
    const phases = r.phases instanceof Set ? new Set(r.phases) : new Set(r.phases || ['thinking', 'text', 'tool_input']);
    const allowAckIn =
      r.allowAckIn instanceof Set ? new Set(r.allowAckIn) : new Set(r.allowAckIn || ['thinking', 'text']);
    const tools = r.tools ? (r.tools instanceof Set ? new Set(r.tools) : new Set(r.tools)) : null;
    const minMatches = Number(r.minMatches) > 1 ? Number(r.minMatches) : 1;

    let bareRegex = null;
    let unacknowledgedRegex = null;
    let acknowledgedRegex = null;
    let globalBareRegex = null;
    let globalUnacknowledgedRegex = null;
    let globalAcknowledgedRegex = null;
    const hasTrailingNegativeLookahead = Boolean(rawSource && /\(\?!/.test(rawSource));
    const endsWithWordBoundary = Boolean(
      rawSource &&
        (r.deferIncompleteWords || hasTrailingNegativeLookahead || /\\b(?:\(\?!.*)?$/.test(rawSource))
    );

    if (rawSource) {
      // Treat JSON string escape sequences (`\n`, `\r`, `\t`) as valid leading word boundaries
      // across pattern starts, alternations, non-capturing groups, and whitespace prefixes
      // so tokens like `\nit.skip` or `\twrangler` inside serialized `tool_input` JSON are caught!
      const jsonSafeSource = rawSource.replace(/(^|\||\(\?:|\(\?<!|\s\*)\\b/g, '$1(?:\\b|(?<=\\\\[nrt]))');
      bareRegex = new RegExp(`(?:${jsonSafeSource})`, baseFlags);
      globalBareRegex = new RegExp(`(?:${jsonSafeSource})`, baseFlags + 'g');
      if (ackPrefix) {
        const escPrefix = escapeRegExp(ackPrefix);
        unacknowledgedRegex = new RegExp(`(?<!${escPrefix})(?:${jsonSafeSource})`, baseFlags);
        globalUnacknowledgedRegex = new RegExp(`(?<!${escPrefix})(?:${jsonSafeSource})`, baseFlags + 'g');
        acknowledgedRegex = new RegExp(`${escPrefix}(?:${jsonSafeSource})`, baseFlags);
        globalAcknowledgedRegex = new RegExp(`${escPrefix}(?:${jsonSafeSource})`, baseFlags + 'g');
      } else {
        unacknowledgedRegex = bareRegex;
        globalUnacknowledgedRegex = globalBareRegex;
      }
    }

    const rawContext = r.rawUnsanitizedContext || r.additionalContext || r.message || '';
    const sanitizedContext =
      ackPrefix && unacknowledgedRegex && r.autoSanitizeContext !== false
        ? sanitizeInstructionWithPrefix(rawContext, unacknowledgedRegex, ackPrefix)
        : r.promptReplacement && globalBareRegex && r.autoSanitizeContext !== false
          ? rawContext.replace(globalBareRegex, r.promptReplacement)
          : rawContext;

    const rawMode = r.mode ? String(r.mode).toLowerCase() : null;
    const rawAction =
      r.action ||
      r.decision ||
      (rawMode === 'slipstream' && r.replacement == null && !r.handler ? 'continue' : rawMode) ||
      'abort';
    const normalizedAction = ACTION_TO_DECISION[rawAction] || 'abort';
    const holdbackChunks =
      r.holdbackChunks !== undefined
        ? Math.max(0, Number(r.holdbackChunks) || 0)
        : rawAction === 'redact'
          ? 2
          : normalizedAction === 'inject'
            ? 1
            : 0;
    const executionMode =
      rawMode ||
      (normalizedAction === 'abort'
        ? 'fly-by-wire'
        : normalizedAction === 'ask'
          ? 'clearance'
          : 'slipstream');
    const defaultReplacement =
      rawAction === 'redact' && r.replacement === undefined ? '[REDACTED]' : (r.replacement ?? null);
    const pendingPrefixRegex =
      r.pendingPrefixRegex instanceof RegExp
        ? r.pendingPrefixRegex
        : (normalizedAction === 'abort' || normalizedAction === 'inject') && rawSource
          ? buildPendingPrefixRegexFromSource(rawSource, baseFlags)
          : null;
    const hasTrailingCharClassQuantifier = Boolean(pendingPrefixRegex && !hasTrailingNegativeLookahead);

    return Object.freeze({
      _compiled: true,
      id: r.id,
      mode: executionMode,
      pattern: rawPattern,
      rawSource,
      baseFlags,
      endsWithWordBoundary,
      hasTrailingNegativeLookahead,
      hasTrailingCharClassQuantifier,
      deferIncompleteWords: Boolean(r.deferIncompleteWords),
      phases,
      allowAckIn,
      tools,
      ackPrefix,
      minMatches,
      holdbackChunks,
      pendingPrefixRegex,
      bareRegex,
      unacknowledgedRegex,
      acknowledgedRegex,
      globalBareRegex,
      globalUnacknowledgedRegex,
      globalAcknowledgedRegex,
      match: typeof r.match === 'function' ? r.match : (typeof r.matchFn === 'function' ? r.matchFn : null),
      matchFn: typeof r.match === 'function' ? r.match : (typeof r.matchFn === 'function' ? r.matchFn : null),
      tier2: typeof r.tier2 === 'function' ? r.tier2 : null,
      tier3: typeof r.tier3 === 'function' ? r.tier3 : null,
      handler: typeof r.handler === 'function' ? r.handler : null,
      action: rawAction,
      decision: normalizedAction,
      replacement: defaultReplacement,
      prefillReplacement: r.prefillReplacement ?? null,
      promptReplacement: r.promptReplacement ?? null,
      permissionPrompt: r.permissionPrompt ?? null,
      rawUnsanitizedContext: rawContext,
      additionalContext: sanitizedContext,
    });
  });
}

function decodePrintableJsonUnicodeAscii(str) {
  if (!str || !/\\u00[2-7][0-9a-fA-F]/i.test(str)) return str;
  return str.replace(/\\u00([2-7][0-9a-fA-F])/gi, (full, hex) => {
    const code = parseInt(hex, 16);
    if (code === 0x22 || code === 0x5c) return full;
    return String.fromCharCode(code);
  });
}

export class MidstreamSession {
  /**
   * @param {Object} options
   * @param {Array<Object>} options.rules - Declarative or compiled midstream hooks
   * @param {number} [options.windowSize=256] - Rolling character window for cross-chunk matching
   * @param {boolean} [options.deferIncompleteWords=true] - When true, trailing `\b` matches ending at the exact last word-char of a chunk wait for the next chunk or `onBlockStop`
   */
  constructor({ rules = [], windowSize = 256, deferIncompleteWords = true } = {}) {
    this.windowSize = windowSize;
    this.deferIncompleteWords = Boolean(deferIncompleteWords);
    this.rules =
      rules.length > 0 &&
      rules.every(
        (r) =>
          r &&
          r._compiled === true &&
          r.pendingPrefixRegex !== undefined &&
          r.hasTrailingNegativeLookahead !== undefined
      )
        ? rules
        : compileRules(rules);

    this.blocks = new Map();
    this.blockEpoch = 0;
    this.acknowledgedHits = new Set();
    this.acknowledgedPositions = new Set();
    this.ruleMatchHits = new Map(); // ruleId -> Map(candidateKey -> matchedLength)
    this.metrics = {
      chunksEvaluated: 0,
      totalEvalNs: 0n,
      maxEvalNs: 0n,
      charsStreamed: 0,
      tier1Hits: 0,
      tier2Evaluations: 0,
      tier3Evaluations: 0,
      acknowledgedReferences: [],
      hookEvents: [],
    };
    this.abortedVerdict = null;
  }

  onBlockStart({ index, type, toolName = null, toolId = null }) {
    const phase =
      type === 'thinking'
        ? 'thinking'
        : type === 'tool_use'
          ? 'tool_input'
          : 'text';
    this.blockEpoch += 1;

    this.blocks.set(index, {
      index,
      epoch: this.blockEpoch,
      type,
      phase,
      toolName,
      toolId,
      rawFullText: '',
      fullText: '',
      rollingWindow: '',
      scanStart: 0,
      chunks: 0,
      hasDeferredMatch: false,
    });
  }

  _updateBlockRollingWindow(block, delta) {
    block.chunks += 1;
    block.rawFullText += delta;
    block.fullText += delta;

    // Token-boundary-aligned rolling window on `rawFullText`, capped to a 64-char backtrack
    // so prefixes (`deprecated:`) and composite identifiers (`nonwrangler`, `subpathogen`)
    // are never sliced in half at the left edge while 128KB contiguous base64/JWT/hex strings
    // remain strictly O(1) per chunk (~1-3 µs/chunk).
    const targetStart = Math.max(0, block.rawFullText.length - delta.length - this.windowSize);
    const minScanStart = Math.max(0, targetStart - 64);
    let scanStart = targetStart;
    while (scanStart > minScanStart && /[A-Za-z0-9_:@./-]/.test(block.rawFullText[scanStart - 1])) {
      scanStart -= 1;
    }
    if (scanStart === minScanStart && scanStart > 0 && /[A-Za-z0-9_]/.test(block.rawFullText[scanStart - 1])) {
      block.scanStart = scanStart - 1;
      block.rollingWindow = '_' + block.rawFullText.slice(scanStart);
    } else {
      block.scanStart = scanStart;
      block.rollingWindow = block.rawFullText.slice(scanStart);
    }

    this.metrics.chunksEvaluated += 1;
    this.metrics.charsStreamed += delta.length;
  }

  _shouldDeferRightEdgeMatch(rule, windowStr, matchText, matchEndInWindow, isBlockStop) {
    if (isBlockStop) return false;
    const effectiveDefer =
      this.deferIncompleteWords || rule.deferIncompleteWords || rule.hasTrailingNegativeLookahead;
    if (!effectiveDefer || !rule.endsWithWordBoundary) return false;
    if (rule.hasTrailingCharClassQuantifier && rule.decision === 'abort' && !/^[A-Za-z]+$/.test(matchText)) {
      return false;
    }
    const tailAfterMatch = windowStr.slice(matchEndInWindow);
    if (!/^(?:[./-][A-Za-z0-9_./-]*)?$/.test(tailAfterMatch)) return false;
    return /[A-Za-z0-9_]$/.test(matchText);
  }

  _getRuleScanWindow(block, rule) {
    let windowStr = block.rollingWindow;
    let scanStart = block.scanStart;
    if (block.phase === 'tool_input' && /\\u00[2-7][0-9a-fA-F]/i.test(windowStr)) {
      windowStr = decodePrintableJsonUnicodeAscii(windowStr);
    }
    if (
      rule.id === 'no-git-verify-bypass' &&
      block.rawFullText.length > block.rollingWindow.length &&
      /(?:^|[\s"'])-(?:[a-uw-zA-Z]*n[a-zA-Z]*|-no-verif?y?)\b/i.test(windowStr)
    ) {
      const longStart = Math.max(0, block.rawFullText.length - 4096);
      scanStart = longStart;
      windowStr = block.rawFullText.slice(longStart);
      if (block.phase === 'tool_input' && /\\u00[2-7][0-9a-fA-F]/i.test(windowStr)) {
        windowStr = decodePrintableJsonUnicodeAscii(windowStr);
      }
    }
    return { windowStr, scanStart };
  }

  /**
   * Flushes any deferred end-of-block word-boundary matches when `content_block_stop` arrives.
   */
  onBlockStop(index = 0) {
    if (this.abortedVerdict) return this.abortedVerdict;
    const block = this.blocks.get(index);
    if (!block) return null;
    if (
      !this.deferIncompleteWords &&
      !this.rules.some((r) => r.deferIncompleteWords || r.hasTrailingNegativeLookahead)
    ) {
      return null;
    }
    const verdict = this._evaluateWindow(block, '', { isBlockStop: true, t0: process.hrtime.bigint() });
    return verdict.decision === 'allow' ? null : verdict;
  }

  /**
   * Async version of `onBlockStop` for rules with async `tier2`, `tier3`, or `handler` callbacks.
   */
  async onBlockStopAsync(index = 0) {
    if (this.abortedVerdict) return this.abortedVerdict;
    const block = this.blocks.get(index);
    if (!block) return null;
    if (
      !this.deferIncompleteWords &&
      !this.rules.some((r) => r.deferIncompleteWords || r.hasTrailingNegativeLookahead)
    ) {
      return null;
    }
    const verdict = await this._evaluateWindowAsync(block, '', { isBlockStop: true, t0: process.hrtime.bigint() });
    return verdict.decision === 'allow' ? null : verdict;
  }

  /**
   * The Midstream ("During") Hook Call Site.
   */
  onDelta({ index = 0, phase, delta, toolName = null, isBlockStop = false }) {
    if (this.abortedVerdict) return this.abortedVerdict;
    if (!delta && !isBlockStop) return { decision: 'allow', delta, evalUs: 0 };

    const t0 = process.hrtime.bigint();

    let block = this.blocks.get(index);
    if (!block || (phase && block.phase !== phase)) {
      this.blockEpoch += 1;
      block = {
        index,
        epoch: this.blockEpoch,
        type: phase,
        phase,
        toolName: toolName || null,
        toolId: null,
        rawFullText: '',
        fullText: '',
        rollingWindow: '',
        scanStart: 0,
        chunks: 0,
        hasDeferredMatch: false,
      };
      this.blocks.set(index, block);
    } else if (toolName && !block.toolName) {
      block.toolName = toolName;
    }

    if (delta) {
      this._updateBlockRollingWindow(block, delta);
    }

    return this._evaluateWindow(block, delta || '', { isBlockStop, t0 });
  }

  /**
   * Async Midstream ("During") Hook Call Site for rules whose `tier2`, `tier3`
   * (e.g. an async HTTP/IPC call to a millisecond calibrated decision model like a calibrated System-1 classifier),
   * or `handler` return a `Promise`.
   */
  async onDeltaAsync({ index = 0, phase, delta, toolName = null, isBlockStop = false }) {
    if (this.abortedVerdict) return this.abortedVerdict;
    if (!delta && !isBlockStop) return { decision: 'allow', delta, evalUs: 0 };

    const t0 = process.hrtime.bigint();

    let block = this.blocks.get(index);
    if (!block || (phase && block.phase !== phase)) {
      this.blockEpoch += 1;
      block = {
        index,
        epoch: this.blockEpoch,
        type: phase,
        phase,
        toolName: toolName || null,
        toolId: null,
        rawFullText: '',
        fullText: '',
        rollingWindow: '',
        scanStart: 0,
        chunks: 0,
        hasDeferredMatch: false,
      };
      this.blocks.set(index, block);
    } else if (toolName && !block.toolName) {
      block.toolName = toolName;
    }

    if (delta) {
      this._updateBlockRollingWindow(block, delta);
    }

    return this._evaluateWindowAsync(block, delta || '', { isBlockStop, t0 });
  }

  async _evaluateWindowAsync(block, delta, { isBlockStop = false, t0 }) {
    const wrappedRules = this.rules.map((r) => {
      if (!r.tier2 && !r.tier3 && !r.handler) return r;
      return { ...r };
    });
    const origRules = this.rules;
    try {
      // Pre-resolve any async tier2/tier3/handler callbacks for matching rules in the current window
      for (const rule of wrappedRules) {
        if (!rule.phases.has(block.phase)) continue;
        if (rule.tools && (!block.toolName || !rule.tools.has(block.toolName))) continue;
        const { windowStr, scanStart } = this._getRuleScanWindow(block, rule);
        if (rule.bareRegex && !rule.bareRegex.test(windowStr)) continue;
        if (rule.tier2 || rule.tier3 || rule.handler) {
          const origTier2 = rule.tier2;
          const origTier3 = rule.tier3;
          const origHandler = rule.handler;
          const cache = new Map();
          const hitMap = this.ruleMatchHits.get(rule.id);
          const globalActive =
            rule.ackPrefix && rule.allowAckIn.has(block.phase)
              ? rule.globalUnacknowledgedRegex
              : rule.globalBareRegex;
          if (globalActive) {
            globalActive.lastIndex = 0;
            let m;
            while ((m = globalActive.exec(windowStr)) !== null) {
              const matchEndInWindow = m.index + m[0].length;
              if (this._shouldDeferRightEdgeMatch(rule, windowStr, m[0], matchEndInWindow, isBlockStop)) {
                if (m[0].length === 0) globalActive.lastIndex += 1;
                continue;
              }
              const absPos = scanStart + m.index;
              const candidateKey = `${block.index}:${block.phase}:${block.epoch || 0}:${absPos}`;
              // Never re-evaluate a match at `candidateKey` that was already evaluated (or vetoed) on an earlier chunk!
              if (hitMap && hitMap.has(candidateKey)) {
                if (m[0].length === 0) globalActive.lastIndex += 1;
                continue;
              }
              const ctx = {
                ruleId: rule.id,
                phase: block.phase,
                toolName: block.toolName,
                blockIndex: block.index,
                chunkIndex: block.chunks,
                delta,
                matchedText: m[0],
                matchKey: candidateKey,
                matchCount: (hitMap?.size || 0) + 1,
                rollingWindow: windowStr,
                fullText: block.fullText,
                session: this,
                isBlockStop,
              };
              const t2 = origTier2 ? await origTier2(ctx) : null;
              let esc = Boolean(origTier3);
              if (t2 === false) esc = false;
              else if (t2 && typeof t2 === 'object' && t2.escalate !== undefined) esc = Boolean(t2.escalate);
              else if (t2 && typeof t2 === 'object' && ACTION_TO_DECISION[t2.decision || t2.action] === 'allow') esc = false;
              const t3 = esc && origTier3 ? await origTier3({ ...ctx, tier2Result: t2 }) : null;
              const t3Decision =
                t3 === false
                  ? 'allow'
                  : t3 && typeof t3 === 'object' && (t3.decision || t3.action)
                    ? ACTION_TO_DECISION[t3.decision || t3.action]
                    : null;
              const vetoed =
                t2 === false ||
                (t2 && typeof t2 === 'object' && ACTION_TO_DECISION[t2.decision || t2.action] === 'allow') ||
                t3Decision === 'allow';
              const h = !vetoed && origHandler ? await origHandler(ctx) : null;
              cache.set(candidateKey, { t2, t3, h });
              if (m[0].length === 0) globalActive.lastIndex += 1;
            }
          }
          if (origTier2) {
            rule.tier2 = (ctx) => {
              if (ctx.matchKey && cache.has(ctx.matchKey)) return cache.get(ctx.matchKey).t2;
              return origTier2(ctx);
            };
          }
          if (origTier3) {
            rule.tier3 = (ctx) => {
              if (ctx.matchKey && cache.has(ctx.matchKey)) return cache.get(ctx.matchKey).t3;
              return origTier3(ctx);
            };
          }
          if (origHandler) {
            rule.handler = (ctx) => {
              if (ctx.matchKey && cache.has(ctx.matchKey)) return cache.get(ctx.matchKey).h;
              return origHandler(ctx);
            };
          }
        }
      }
      this.rules = wrappedRules;
      return this._evaluateWindow(block, delta, { isBlockStop, t0 });
    } finally {
      this.rules = origRules;
    }
  }

  _evaluateWindow(block, delta, { isBlockStop = false, t0 }) {
    const index = block.index;
    const epoch = block.epoch || 0;
    block.hasDeferredMatch = false;
    let effectiveDelta = delta;
    let bestVerdict = null;

    for (const rule of this.rules) {
      if (!rule.phases.has(block.phase)) continue;
      // Tool-scoped rules (`rule.tools`) must ONLY fire when `block.toolName` is present and in `rule.tools`
      if (rule.tools && (!block.toolName || !rule.tools.has(block.toolName))) continue;
      const { windowStr, scanStart } = this._getRuleScanWindow(block, rule);
      // Fast-path pre-filter: if the bare pattern is not present anywhere in the rolling window,
      // neither an acknowledged reference nor an unacknowledged violation can exist in this window.
      if (rule.bareRegex && !rule.bareRegex.test(windowStr)) continue;

      const ackAllowedHere = Boolean(rule.ackPrefix && rule.allowAckIn.has(block.phase));

      // 1. Track acknowledged references (e.g. `deprecated:wrangler`)
      if (ackAllowedHere && rule.globalAcknowledgedRegex) {
        const globalAckRegex = rule.globalAcknowledgedRegex;
        globalAckRegex.lastIndex = 0;
        let ackMatch;
        while ((ackMatch = globalAckRegex.exec(windowStr)) !== null) {
          const matchEndInWindow = ackMatch.index + ackMatch[0].length;
          if (this._shouldDeferRightEdgeMatch(rule, windowStr, ackMatch[0], matchEndInWindow, isBlockStop)) {
            block.hasDeferredMatch = true;
            if (ackMatch[0].length === 0) globalAckRegex.lastIndex += 1;
            continue;
          }
          const absPos = scanStart + ackMatch.index;
          const bareAbsPos = absPos + (rule.ackPrefix ? rule.ackPrefix.length : 0);
          this.acknowledgedPositions.add(`${rule.id}:${index}:${block.phase}:${epoch}:${bareAbsPos}`);
          const hitKey = `${rule.id}:${index}:${block.phase}:${epoch}:${absPos}`;
          if (!this.acknowledgedHits.has(hitKey)) {
            this.acknowledgedHits.add(hitKey);
            this.metrics.acknowledgedReferences.push({
              ruleId: rule.id,
              phase: block.phase,
              chunkIndex: block.chunks,
              token: ackMatch[0],
            });
          }
          if (ackMatch[0].length === 0) globalAckRegex.lastIndex += 1;
        }
      }

      // 2. Scan for unacknowledged / policy-triggering matches
      let matchedText = null;
      let firstNewMatchIndexInWindow = -1;
      let continuationTrimChars = 0;
      const newMatches = [];
      const activeRegex = ackAllowedHere ? rule.unacknowledgedRegex : rule.bareRegex;
      const globalActiveRegex = ackAllowedHere ? rule.globalUnacknowledgedRegex : rule.globalBareRegex;

      let hitMap = this.ruleMatchHits.get(rule.id);
      if (!hitMap) {
        hitMap = new Map();
        this.ruleMatchHits.set(rule.id, hitMap);
      }

      if (globalActiveRegex) {
        globalActiveRegex.lastIndex = 0;
        let m;
        while ((m = globalActiveRegex.exec(windowStr)) !== null) {
          const matchEndInWindow = m.index + m[0].length;
          // Right-edge word-boundary guard: if the match touches the exact end of the chunk
          // with a word character, wait for the next chunk or `onBlockStop` when `deferIncompleteWords` is enabled.
          if (this._shouldDeferRightEdgeMatch(rule, windowStr, m[0], matchEndInWindow, isBlockStop)) {
            block.hasDeferredMatch = true;
            if (m[0].length === 0) globalActiveRegex.lastIndex += 1;
            continue;
          }

          const absPos = scanStart + m.index;
          if (
            ackAllowedHere &&
            rule.ackPrefix &&
            (this.acknowledgedPositions.has(`${rule.id}:${index}:${block.phase}:${epoch}:${absPos}`) ||
              (absPos >= rule.ackPrefix.length &&
                block.rawFullText.slice(absPos - rule.ackPrefix.length, absPos).toLowerCase() ===
                  rule.ackPrefix.toLowerCase()))
          ) {
            if (m[0].length === 0) globalActiveRegex.lastIndex += 1;
            continue;
          }
          const candidateKey = `${index}:${block.phase}:${epoch}:${absPos}`;
          if (!hitMap.has(candidateKey)) {
            hitMap.set(candidateKey, m[0].length);
            newMatches.push({ key: candidateKey, text: m[0], index: m.index });
            if (matchedText === null) {
              matchedText = m[0];
              firstNewMatchIndexInWindow = m.index;
            }
          } else if (rule.decision === 'inject') {
            // Variable-length token continuation across chunks (e.g. `ghp_[A-Za-z0-9]{12,}` where
            // first 20 chars matched in Chunk A and remaining 20 chars arrive in Chunk B):
            const prevLen = hitMap.get(candidateKey);
            if (prevLen > 0 && m[0].length > prevLen) {
              const extraChars = m[0].length - prevLen;
              hitMap.set(candidateKey, m[0].length);
              continuationTrimChars += extraChars;
            }
          }
          if (m[0].length === 0) globalActiveRegex.lastIndex += 1;
        }
      } else if (rule.matchFn) {
        const res = rule.matchFn({
          delta: effectiveDelta,
          rollingWindow: windowStr,
          fullText: block.fullText,
          phase: block.phase,
          toolName: block.toolName,
          chunks: block.chunks,
          session: this,
          isBlockStop,
        });
        if (res) {
          matchedText = typeof res === 'string' ? res : effectiveDelta;
          const matchIdx = windowStr.lastIndexOf(matchedText);
          firstNewMatchIndexInWindow = matchIdx >= 0 ? matchIdx : Math.max(0, windowStr.length - effectiveDelta.length);
          const absPos = scanStart + firstNewMatchIndexInWindow;
          const candidateKey = `${index}:${block.phase}:${epoch}:${absPos}`;
          if (!hitMap.has(candidateKey)) {
            hitMap.set(candidateKey, matchedText.length);
            newMatches.push({ key: candidateKey, text: matchedText, index: firstNewMatchIndexInWindow });
          } else {
            matchedText = null;
          }
        }
      }

      // If an already-rewritten variable-length match (such as a 40-char `ghp_...` secret) continued
      // into the current chunk without starting a new match, strip the trailing secret suffix!
      if (continuationTrimChars > 0 && newMatches.length === 0 && rule.decision === 'inject') {
        const strippedDelta = effectiveDelta.slice(Math.min(effectiveDelta.length, continuationTrimChars));
        block.fullText = block.fullText.slice(0, block.fullText.length - effectiveDelta.length) + strippedDelta;
        effectiveDelta = strippedDelta;
        const elapsedNs = process.hrtime.bigint() - t0;
        const contVerdict = {
          decision: 'inject',
          mode: rule.mode,
          action: rule.action,
          ruleId: rule.id,
          phase: block.phase,
          toolName: block.toolName,
          blockIndex: index,
          chunkIndex: block.chunks,
          matchedText: '',
          matchCount: hitMap.size,
          ackPrefix: rule.ackPrefix,
          additionalContext: rule.additionalContext,
          permissionPrompt: rule.permissionPrompt,
          injectedText: effectiveDelta,
          replacementDelta: effectiveDelta,
          spanPrefixCharsInPrevChunks: 0,
          evalUs: Number(elapsedNs) / 1000,
          Snippet: windowStr,
        };
        if (
          !bestVerdict ||
          DECISION_SEVERITY.inject > DECISION_SEVERITY[bestVerdict.decision] ||
          bestVerdict.decision === 'inject'
        ) {
          bestVerdict = contVerdict;
        }
      }

      const countValidHits = (map) => {
        let count = 0;
        for (const len of map.values()) {
          if (len > 0) count += 1;
        }
        return count;
      };

      if (newMatches.length > 0) {
        if (countValidHits(hitMap) < rule.minMatches) {
          continue;
        }

        let decision = 'allow';
        let additionalContext = rule.additionalContext;
        let permissionPrompt = rule.permissionPrompt;
        let customReplaceDelta = undefined;
        let survivingMatch = null;

        for (const matchEntry of newMatches) {
          this.metrics.tier1Hits += 1;

          let mDecision = rule.decision;
          let mAdditionalContext = rule.additionalContext;
          let mPermissionPrompt = rule.permissionPrompt;
          let mCustomReplaceDelta = undefined;

          const hookContext = {
            ruleId: rule.id,
            phase: block.phase,
            toolName: block.toolName,
            blockIndex: index,
            chunkIndex: block.chunks,
            delta: effectiveDelta,
            matchedText: matchEntry.text,
            matchKey: matchEntry.key,
            matchCount: countValidHits(hitMap),
            rollingWindow: windowStr,
            fullText: block.fullText,
            session: this,
            isBlockStop,
          };

          // Three-Tier Escalation Funnel (`Tier 1 -> Tier 2 -> Tier 3`)
          let escalateToTier3 = Boolean(rule.tier3);
          let tierVetoed = false;
          let tier2Result = null;
          if (rule.tier2) {
            this.metrics.tier2Evaluations += 1;
            tier2Result = rule.tier2(hookContext);
            if (tier2Result && typeof tier2Result.then === 'function') {
              tier2Result.catch?.(() => {});
              // Fail closed to the rule's default decision when an async Tier 2 check
              // is invoked from synchronous `onDelta` (use `onDeltaAsync` to await async Tier 2/3 verdicts)
              escalateToTier3 = false;
            } else if (tier2Result === false) {
              mDecision = 'allow';
              tierVetoed = true;
              escalateToTier3 = false;
            } else if (tier2Result && typeof tier2Result === 'object') {
              if (tier2Result.decision || tier2Result.action) {
                mDecision = ACTION_TO_DECISION[tier2Result.decision || tier2Result.action] || mDecision;
                if (mDecision === 'allow') tierVetoed = true;
              }
              if (tier2Result.additionalContext !== undefined) {
                mAdditionalContext = tier2Result.additionalContext;
              }
              if (tier2Result.permissionPrompt !== undefined) {
                mPermissionPrompt = tier2Result.permissionPrompt;
              }
              if (tier2Result.escalate !== undefined) {
                escalateToTier3 = Boolean(tier2Result.escalate);
              } else if (tierVetoed) {
                escalateToTier3 = false;
              }
            }
          }

          if (escalateToTier3 && rule.tier3) {
            this.metrics.tier3Evaluations += 1;
            const tier3Out = rule.tier3({ ...hookContext, tier2Result });
            if (tier3Out && typeof tier3Out.then === 'function') {
              tier3Out.catch?.(() => {});
              // Fail closed to the rule's default decision (`abort`) when an async Tier 3 classifier
              // is invoked from synchronous `onDelta` (use `onDeltaAsync` to await async Tier 3 verdicts)
            } else if (tier3Out === false) {
              mDecision = 'allow';
              tierVetoed = true;
            } else if (tier3Out && typeof tier3Out === 'object') {
              if (tier3Out.decision || tier3Out.action) {
                mDecision = ACTION_TO_DECISION[tier3Out.decision || tier3Out.action] || mDecision;
                if (mDecision === 'allow') tierVetoed = true;
              }
              if (tier3Out.additionalContext !== undefined) {
                mAdditionalContext = tier3Out.additionalContext;
              }
              if (tier3Out.permissionPrompt !== undefined) {
                mPermissionPrompt = tier3Out.permissionPrompt;
              }
              if (tier3Out.injectedText !== undefined || tier3Out.replacementDelta !== undefined) {
                mCustomReplaceDelta = tier3Out.injectedText ?? tier3Out.replacementDelta;
                if (!tier3Out.decision && !tier3Out.action) {
                  mDecision = 'inject';
                }
              }
            }
          }

          // Run custom handler / Universal Dispatcher BEFORE mutating `fullText`
          if (rule.handler && !tierVetoed) {
            const customOut = rule.handler(hookContext);
            if (customOut && typeof customOut.then === 'function') {
              customOut.catch?.(() => {});
            } else if (customOut && typeof customOut === 'object') {
              if (customOut.decision || customOut.action) {
                mDecision = ACTION_TO_DECISION[customOut.decision || customOut.action] || mDecision;
              }
              if (customOut.additionalContext !== undefined) {
                mAdditionalContext = customOut.additionalContext;
              }
              if (customOut.permissionPrompt !== undefined) {
                mPermissionPrompt = customOut.permissionPrompt;
              }
              if (customOut.injectedText !== undefined || customOut.replacementDelta !== undefined) {
                mCustomReplaceDelta = customOut.injectedText ?? customOut.replacementDelta;
                if (!customOut.decision && !customOut.action) {
                  mDecision = 'inject';
                }
              }
            }
          }

          // If tier2/tier3/handler vetoed this specific match to `allow`, mark its `hitMap` entry as `0`
          // so it does not count toward `minMatches` and is not re-evaluated on subsequent rolling-window slides
          if (mDecision === 'allow' && rule.decision !== 'allow') {
            hitMap.set(matchEntry.key, 0);
            continue;
          }

          if (
            survivingMatch === null ||
            DECISION_SEVERITY[mDecision] > DECISION_SEVERITY[decision]
          ) {
            survivingMatch = matchEntry;
            decision = mDecision;
            additionalContext = mAdditionalContext;
            permissionPrompt = mPermissionPrompt;
            customReplaceDelta = mCustomReplaceDelta;
          }

          if (mDecision === 'abort') {
            break;
          }
        }

        if (!survivingMatch && decision === 'allow' && rule.decision !== 'allow') {
          continue;
        }
        if (survivingMatch) {
          matchedText = survivingMatch.text;
          firstNewMatchIndexInWindow = survivingMatch.index;
        }
        const matchCount = countValidHits(hitMap);
        if (matchCount < rule.minMatches) {
          continue;
        }

        let replacementDelta = null;
        let spanPrefixCharsInPrevChunks = 0;
        const deltaAlreadyMutated = effectiveDelta !== delta;
        const prevEffectiveLen = effectiveDelta.length;
        const deltaStartInWindow = Math.max(0, windowStr.length - delta.length);
        if (!deltaAlreadyMutated && firstNewMatchIndexInWindow >= 0 && firstNewMatchIndexInWindow < deltaStartInWindow) {
          spanPrefixCharsInPrevChunks = deltaStartInWindow - firstNewMatchIndexInWindow;
        }

        if (decision === 'inject') {
          if (block.phase === 'tool_input' && /\\u00[2-7][0-9a-fA-F]/i.test(effectiveDelta)) {
            effectiveDelta = decodePrintableJsonUnicodeAscii(effectiveDelta);
          }
          if (continuationTrimChars > 0) {
            effectiveDelta = effectiveDelta.slice(Math.min(effectiveDelta.length, continuationTrimChars));
          }
          if (customReplaceDelta !== undefined) {
            replacementDelta = customReplaceDelta;
          } else if (rule.replacement !== null) {
            const rawReplaceStr =
              typeof rule.replacement === 'function' ? rule.replacement(matchedText) : rule.replacement;
            const replaceStr =
              block.phase === 'tool_input' && typeof rawReplaceStr === 'string'
                ? rawReplaceStr.replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t')
                : rawReplaceStr;
            const replaceRegex = activeRegex || new RegExp(escapeRegExp(matchedText), 'i');
            const globalReplaceRegex = new RegExp(
              replaceRegex.source,
              replaceRegex.flags.includes('g') ? replaceRegex.flags : replaceRegex.flags + 'g'
            );

            if (spanPrefixCharsInPrevChunks > 0) {
              const charsInCurrentDelta = Math.max(0, matchedText.length - spanPrefixCharsInPrevChunks);
              const remainder = effectiveDelta.slice(charsInCurrentDelta).replace(globalReplaceRegex, replaceStr);
              replacementDelta = replaceStr + remainder;
            } else {
              const replaced = effectiveDelta.replace(globalReplaceRegex, replaceStr);
              if (
                !deltaAlreadyMutated &&
                replaced === effectiveDelta &&
                firstNewMatchIndexInWindow >= deltaStartInWindow
              ) {
                // Match succeeded in `windowStr` via a lookbehind across the chunk boundary
                // (e.g. `\` in Chunk 1 + `nit.skip` in Chunk 2 matching `(?<=\\[nrt])it\.skip`)
                const offsetInDelta = firstNewMatchIndexInWindow - deltaStartInWindow;
                const prefix = effectiveDelta.slice(0, offsetInDelta);
                const rest = effectiveDelta
                  .slice(offsetInDelta + matchedText.length)
                  .replace(globalReplaceRegex, replaceStr);
                replacementDelta = prefix + replaceStr + rest;
              } else {
                replacementDelta = replaced;
              }
            }
          } else {
            replacementDelta = effectiveDelta;
          }

          if (spanPrefixCharsInPrevChunks > 0) {
            block.fullText =
              block.fullText.slice(0, block.fullText.length - prevEffectiveLen - spanPrefixCharsInPrevChunks) +
              replacementDelta;
          } else {
            block.fullText =
              block.fullText.slice(0, block.fullText.length - prevEffectiveLen) + replacementDelta;
          }
          effectiveDelta = replacementDelta;
        }

        const elapsedNs = process.hrtime.bigint() - t0;
        this.metrics.totalEvalNs += elapsedNs;
        if (elapsedNs > this.metrics.maxEvalNs) this.metrics.maxEvalNs = elapsedNs;

        const finalInjectedText = replacementDelta !== null ? replacementDelta : effectiveDelta;

        // Compute `prefillText` for assistant-prefill continuation (`buildPrefillContinuationBody`):
        // Only applicable to `thinking` or `text` blocks (never `tool_input`, because partial JSON tool calls
        // cannot be prefilled via assistant text `content` without losing the tool call).
        let prefillText = null;
        if (decision === 'abort' && matchedText && block.phase !== 'tool_input') {
          const absMatchStart = scanStart + firstNewMatchIndexInWindow;
          const prefixBeforeMatch = block.rawFullText.slice(0, Math.max(0, absMatchStart));
          const correctedToken =
            customReplaceDelta !== undefined
              ? customReplaceDelta
              : rule.prefillReplacement !== null && rule.prefillReplacement !== undefined
                ? typeof rule.prefillReplacement === 'function'
                  ? rule.prefillReplacement(matchedText)
                  : rule.prefillReplacement
                : rule.replacement !== null
                  ? typeof rule.replacement === 'function'
                    ? rule.replacement(matchedText)
                    : rule.replacement
                  : rule.promptReplacement !== null
                    ? typeof rule.promptReplacement === 'function'
                      ? rule.promptReplacement(matchedText)
                      : rule.promptReplacement
                    : '';
          prefillText = `${prefixBeforeMatch}${correctedToken}`;
        }

        const safeDeltaPrefix =
          decision === 'abort' &&
          !deltaAlreadyMutated &&
          firstNewMatchIndexInWindow >= deltaStartInWindow
            ? effectiveDelta.slice(0, firstNewMatchIndexInWindow - deltaStartInWindow)
            : '';

        const verdict = {
          decision,
          mode: rule.mode,
          action: rule.action,
          ruleId: rule.id,
          phase: block.phase,
          toolName: block.toolName,
          blockIndex: index,
          chunkIndex: block.chunks,
          matchedText,
          matchCount,
          ackPrefix: rule.ackPrefix,
          additionalContext,
          permissionPrompt,
          prefillText,
          safeDeltaPrefix,
          injectedText: decision === 'inject' ? finalInjectedText : null,
          replacementDelta: decision === 'inject' ? finalInjectedText : null,
          spanPrefixCharsInPrevChunks:
            decision === 'inject' || decision === 'abort' ? spanPrefixCharsInPrevChunks : 0,
          evalUs: Number(elapsedNs) / 1000,
          Snippet: windowStr,
        };

        this.metrics.hookEvents.push({
          ruleId: rule.id,
          decision,
          mode: rule.mode,
          phase: block.phase,
          chunkIndex: block.chunks,
          matchedText,
          matchCount,
        });

        if (
          !bestVerdict ||
          DECISION_SEVERITY[decision] > DECISION_SEVERITY[bestVerdict.decision] ||
          (decision === 'inject' && bestVerdict.decision === 'inject')
        ) {
          bestVerdict = verdict;
        }

        if (decision === 'abort') {
          this.abortedVerdict = verdict;
          return verdict;
        }
      }
    }

    if (bestVerdict) {
      return bestVerdict;
    }

    const elapsedNs = process.hrtime.bigint() - t0;
    this.metrics.totalEvalNs += elapsedNs;
    if (elapsedNs > this.metrics.maxEvalNs) this.metrics.maxEvalNs = elapsedNs;

    return {
      decision: 'allow',
      delta: effectiveDelta,
      evalUs: Number(elapsedNs) / 1000,
    };
  }

  getSummaryMetrics() {
    const count = this.metrics.chunksEvaluated || 1;
    const totalUs = Number(this.metrics.totalEvalNs) / 1000;
    const avgUs = totalUs / count;
    const maxUs = Number(this.metrics.maxEvalNs) / 1000;
    return {
      chunksEvaluated: this.metrics.chunksEvaluated,
      charsStreamed: this.metrics.charsStreamed,
      totalEvalUs: Number(totalUs.toFixed(2)),
      avgEvalUs: Number(avgUs.toFixed(2)),
      maxEvalUs: Number(maxUs.toFixed(2)),
      tier1Hits: this.metrics.tier1Hits,
      tier2Evaluations: this.metrics.tier2Evaluations,
      tier3Evaluations: this.metrics.tier3Evaluations,
      acknowledgedReferences: this.metrics.acknowledgedReferences,
      hookEvents: this.metrics.hookEvents,
    };
  }
}

export { MidstreamSession as MidflightSession };
