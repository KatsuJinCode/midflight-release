#!/usr/bin/env node
/**
 * Standalone Midflight / Midstream SSE Interceptor Proxy (`bin/midstream-proxy.mjs`)
 *
 * Sits between any Anthropic-Messages or OpenAI/LiteLLM-Chat-Completions compatible LLM harness
 * (Claude Code, Codex, OpenCode, Cursor, Cline, Roo Code, Aider) and the upstream API.
 *
 * Features:
 * - Tier 0 Token-Aligned Rolling Window + Semantic Acknowledgement Prefixes (`<tag>:<token>`)
 * - Request-Side Self-Modeling Message Sanitization (`sanitizeRequestMessages`)
 * - Transparent In-Stream Upstream Self-Healing Retry (`buildRetryRequestBody`): when a `FlyByWire`
 *   rule aborts Turn 1 in `<thinking>` or held-back `tool_input`, the proxy can immediately abort
 *   Turn 1 upstream and splice a self-healed Turn 2 upstream stream into the SAME downstream client
 *   SSE response with zero harness modification required.
 *
 * Default port: 9885 (`http://127.0.0.1:9885/anthropic` or `http://127.0.0.1:9885`)
 * Default upstream: `https://api.minimax.io`
 */

import http from 'node:http';
import https from 'node:https';
import { pathToFileURL } from 'node:url';
import { attachMidstreamToProxyStream } from '../src/proxy-adapter.mjs';
import {
  compileRules,
  sanitizeRequestMessages,
  buildRetryRequestBody,
  buildPrefillContinuationBody,
} from '../src/engine.mjs';
import { DEFAULT_OPERATOR_RULES } from '../src/default-rules.mjs';

const COMPILED_DEFAULT_RULES = compileRules(DEFAULT_OPERATOR_RULES);

const PORT = Number(process.env.MIDSTREAM_PORT) || 9885;
const UPSTREAM = new URL(process.env.UPSTREAM_URL || 'https://api.minimax.io');

const recentEvents = [];
let totalRequests = 0;
let totalInterventions = 0;
let totalInStreamRetries = 0;

/**
 * Masks credential/secret matches so live secrets are never logged in plaintext
 * or exposed via `/midstream/events`.
 */
export function maskSensitiveMatch(ruleId, matchedText, rule = null) {
  const str = String(matchedText || '');
  if (!str) return '';
  const hasSecretHoldback = Boolean(
    rule &&
      (rule.pendingPrefixRegex instanceof RegExp ||
        (rule.allowAckIn && typeof rule.allowAckIn.size === 'number' && rule.allowAckIn.size === 0))
  );
  if (
    hasSecretHoldback ||
    ruleId === 'no-live-secret-emission' ||
    /secret|token|key|credential|password/i.test(String(ruleId || '')) ||
    /^(?:sk-ant-|sk-proj-|sk_live_|ghp_|github_pat_|AKIA|AIza|xox[bp]-|glpat-)/.test(str)
  ) {
    return `${str.slice(0, 4)}***[REDACTED]***`;
  }
  return str;
}

function recordEvent(entry) {
  recentEvents.push({ at: new Date().toISOString(), ...entry });
  if (recentEvents.length > 100) recentEvents.shift();
}

export function createMidstreamProxyServer({
  upstreamUrl = UPSTREAM,
  rules = COMPILED_DEFAULT_RULES,
  autoRetryInStream = process.env.MIDSTREAM_AUTO_RETRY !== 'false',
} = {}) {
  const targetUpstream = upstreamUrl instanceof URL ? upstreamUrl : new URL(String(upstreamUrl));
  const compiledRules =
    rules.length > 0 && rules.every((r) => r && r._compiled === true && r.pendingPrefixRegex !== undefined)
      ? rules
      : compileRules(rules);

  return http.createServer((clientReq, clientRes) => {
    const origin = clientReq.headers.origin || '';
    if (!origin || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin)) {
      clientRes.setHeader('Access-Control-Allow-Origin', origin || 'http://127.0.0.1');
    }
    clientRes.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    clientRes.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, x-api-key, anthropic-version, x-midstream-auto-retry'
    );
    if (clientReq.method === 'OPTIONS') {
      clientRes.writeHead(204);
      clientRes.end();
      return;
    }

    if (clientReq.url === '/midstream/health' || clientReq.url === '/midstream/events') {
      clientRes.writeHead(200, { 'Content-Type': 'application/json' });
      clientRes.end(
        JSON.stringify(
          {
            ok: true,
            service: 'midstream-proxy',
            port: PORT,
            upstream: targetUpstream.origin,
            autoRetryInStream,
            stats: {
              totalRequests,
              totalInterventions,
              totalInStreamRetries,
            },
            rules: compiledRules.map((r) => ({
              id: r.id,
              ackPrefix: r.ackPrefix,
              phases: [...r.phases],
            })),
            recentEvents: recentEvents.slice(-25),
          },
          null,
          2
        )
      );
      return;
    }

    totalRequests += 1;

    let upstreamPath = clientReq.url || '/v1/messages';
    if (targetUpstream.hostname === 'api.minimax.io' && upstreamPath.startsWith('/v1/')) {
      upstreamPath = '/anthropic' + upstreamPath;
    }

    const transport = targetUpstream.protocol === 'https:' ? https : http;
    const baseHeaders = { ...clientReq.headers, host: targetUpstream.host };
    delete baseHeaders['accept-encoding'];
    delete baseHeaders['content-length'];
    delete baseHeaders['transfer-encoding'];

    const reqAutoRetry =
      clientReq.headers['x-midstream-auto-retry'] === 'true'
        ? true
        : clientReq.headers['x-midstream-auto-retry'] === 'false'
          ? false
          : autoRetryInStream;

    let activeProxyRes = null;
    let activeUpstreamReq = null;
    let rawClientBody = '';
    let rawClientBuffer = null;

    const cleanupUpstream = () => {
      try {
        if (activeProxyRes && !activeProxyRes.destroyed) {
          activeProxyRes.destroy();
        }
      } catch {}
      try {
        if (activeUpstreamReq && !activeUpstreamReq.destroyed) {
          activeUpstreamReq.destroy();
        }
      } catch {}
    };
    clientReq.on('aborted', cleanupUpstream);
    clientRes.on('close', () => {
      if (!clientRes.writableEnded) {
        cleanupUpstream();
      }
    });

    function emitCleanSseStopOnRetryFailure(statusCode = 502, isPrefillContinuation = false, errorMessage = null) {
      if (clientRes.writableEnded) return;
      const isOpenAiPath = upstreamPath.includes('/chat/completions');
      const isGeminiPath = upstreamPath.includes(':streamGenerateContent');
      const resolvedStatus = Number(statusCode) || 502;
      const resolvedMsg = errorMessage || `Upstream retry failed with HTTP ${resolvedStatus}`;
      try {
        if (isOpenAiPath) {
          clientRes.write(
            `data: ${JSON.stringify({
              error: {
                message: resolvedMsg,
                type: resolvedStatus === 529 ? 'overloaded_error' : 'api_error',
                code: resolvedStatus,
              },
            })}\n\ndata: [DONE]\n\n`
          );
        } else if (isGeminiPath) {
          clientRes.write(
            `data: ${JSON.stringify({
              error: {
                code: resolvedStatus,
                message: resolvedMsg,
                status: resolvedStatus === 529 ? 'UNAVAILABLE' : 'INTERNAL',
              },
            })}\n\n`
          );
        } else {
          let prefix = '';
          if (!isPrefillContinuation) {
            prefix = `event: message_start\ndata: ${JSON.stringify({
              type: 'message_start',
              message: {
                id: 'msg_midstream_retry_error',
                type: 'message',
                role: 'assistant',
                model: 'midstream-proxy',
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 0, output_tokens: 0 },
              },
            })}\n\n`;
          }
          clientRes.write(
            `${prefix}event: error\ndata: ${JSON.stringify({
              type: 'error',
              error: {
                type: resolvedStatus === 529 ? 'overloaded_error' : 'api_error',
                status: resolvedStatus,
                message: resolvedMsg,
              },
            })}\n\n`
          );
        }
        clientRes.end();
      } catch {}
    }

    function dispatchUpstreamTurn(bodyPayload, retryAttempt = 0, blockIndexOffset = 0, isPrefillContinuation = false) {
      const turnHeaders = { ...baseHeaders };
      const bodyLen = Buffer.isBuffer(bodyPayload)
        ? bodyPayload.length
        : bodyPayload
          ? Buffer.byteLength(String(bodyPayload), 'utf8')
          : 0;
      if (bodyLen > 0) {
        turnHeaders['content-length'] = bodyLen;
      }

      const upstreamReq = transport.request(
        {
          protocol: targetUpstream.protocol,
          hostname: targetUpstream.hostname,
          port: targetUpstream.port || (targetUpstream.protocol === 'https:' ? 443 : 80),
          method: clientReq.method,
          path: upstreamPath,
          headers: turnHeaders,
          family: 4,
        },
        (proxyRes) => {
          activeProxyRes = proxyRes;
          const contentType = String(proxyRes.headers['content-type'] || '');
          const isSSE = contentType.includes('text/event-stream');

          if (!clientRes.headersSent) {
            const outHeaders = { ...proxyRes.headers };
            delete outHeaders['content-length'];
            clientRes.writeHead(proxyRes.statusCode || 200, outHeaders);
            if (typeof clientRes.flushHeaders === 'function') {
              clientRes.flushHeaders();
            }
          }

          if (!isSSE || (retryAttempt > 0 && proxyRes.statusCode && proxyRes.statusCode >= 400)) {
            if (retryAttempt > 0 && clientRes.headersSent) {
              proxyRes.resume();
              emitCleanSseStopOnRetryFailure(proxyRes.statusCode || 502, isPrefillContinuation);
              return;
            }
            proxyRes.pipe(clientRes);
            return;
          }

          const canRetryInStream = Boolean(reqAutoRetry && retryAttempt === 0 && rawClientBody);
          const prefillHeader = clientReq.headers['x-midstream-prefill-continuation'];
          const hasPrefillHeader = typeof prefillHeader === 'string' && prefillHeader.length > 0;

          const { session } = attachMidstreamToProxyStream({
            proxyRes,
            upstreamReq,
            clientRes,
            rules: compiledRules,
            holdVisibleTextForRetry: Boolean(canRetryInStream && hasPrefillHeader),
            isContinuationStream: isPrefillContinuation,
            blockIndexOffset,
            onInStreamRetry: canRetryInStream
              ? (verdict, _metrics, retryMeta) => {
                  totalInStreamRetries += 1;
                  const isAutoPrefill = prefillHeader === 'auto' || prefillHeader === 'true';
                  const resolvedPrefill = isAutoPrefill
                    ? retryMeta?.prefillText || verdict?.prefillText || ''
                    : prefillHeader || '';
                  const isOpenAiPath = upstreamPath.includes('/chat/completions');
                  const isGeminiPath = upstreamPath.includes(':streamGenerateContent');
                  const isAnthropicPath = upstreamPath.includes('/v1/messages') || (!isOpenAiPath && !isGeminiPath);
                  const vendor =
                    clientReq.headers['x-midstream-prefill-vendor'] ||
                    (isOpenAiPath ? 'vllm' : isGeminiPath ? 'gemini' : 'anthropic');

                  // Do not use prefill when:
                  // 1. `verdict.phase === 'tool_input'` (unless an explicit visible-text prefill string was passed), so tool calls are never turned into JSON fragments in text
                  // 2. `verdict.phase === 'thinking'` on Anthropic `/v1/messages` with auto prefill, because Anthropic rejects unsigned `<thinking>` blocks
                  const canUsePrefill =
                    hasPrefillHeader &&
                    Boolean(resolvedPrefill) &&
                    !(isAutoPrefill && verdict?.phase === 'tool_input') &&
                    !(isAutoPrefill && isAnthropicPath && verdict?.phase === 'thinking');

                  const effectivePhase =
                    isAutoPrefill && verdict?.phase === 'thinking' ? 'thinking' : 'text';

                  let nextBlockOffset = 0;
                  if (canUsePrefill && !clientRes.writableEnded) {
                    if (isOpenAiPath) {
                      const deltaPayload =
                        effectivePhase === 'thinking'
                          ? { role: 'assistant', reasoning_content: resolvedPrefill }
                          : { role: 'assistant', content: resolvedPrefill };
                      const chunk = {
                        id: 'midstream-prefill',
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model: 'midstream-proxy',
                        choices: [{ index: 0, delta: deltaPayload, finish_reason: null }],
                      };
                      clientRes.write(`data: ${JSON.stringify(chunk)}\n\n`);
                    } else if (isGeminiPath) {
                      const partPayload =
                        effectivePhase === 'thinking'
                          ? { thought: true, text: resolvedPrefill }
                          : { text: resolvedPrefill };
                      const chunk = {
                        candidates: [
                          {
                            content: { role: 'model', parts: [partPayload] },
                            index: 0,
                          },
                        ],
                        modelVersion: 'midstream-proxy',
                      };
                      clientRes.write(`data: ${JSON.stringify(chunk)}\n\n`);
                    } else if (isAnthropicPath) {
                      clientRes.write(
                        `event: message_start\ndata: ${JSON.stringify({
                          type: 'message_start',
                          message: {
                            id: 'msg_midstream_prefill',
                            type: 'message',
                            role: 'assistant',
                            model: 'midstream-proxy',
                            content: [],
                            stop_reason: null,
                            stop_sequence: null,
                            usage: { input_tokens: 0, output_tokens: 0 },
                          },
                        })}\n\nevent: content_block_start\ndata: ${JSON.stringify({
                          type: 'content_block_start',
                          index: 0,
                          content_block: { type: 'text', text: '' },
                        })}\n\nevent: content_block_delta\ndata: ${JSON.stringify({
                          type: 'content_block_delta',
                          index: 0,
                          delta: { type: 'text_delta', text: resolvedPrefill },
                        })}\n\nevent: content_block_stop\ndata: ${JSON.stringify({
                          type: 'content_block_stop',
                          index: 0,
                        })}\n\n`
                      );
                      nextBlockOffset = 1;
                    }
                  }

                  const retryBody = canUsePrefill
                    ? buildPrefillContinuationBody(rawClientBody, resolvedPrefill, compiledRules, {
                        vendor,
                        phase: effectivePhase,
                      })
                    : buildRetryRequestBody(rawClientBody, verdict, compiledRules);
                  dispatchUpstreamTurn(retryBody, retryAttempt + 1, nextBlockOffset, canUsePrefill);
                }
              : null,
            onIntervention: (verdict, metrics, meta) => {
              totalInterventions += 1;
              const matchedRule = compiledRules.find((r) => r.id === verdict.ruleId) || null;
              const safeMatch = maskSensitiveMatch(verdict.ruleId, verdict.matchedText, matchedRule);
              recordEvent({
                kind: meta?.inStreamRetry ? 'in_stream_self_heal' : 'intervention',
                ruleId: verdict.ruleId,
                phase: verdict.phase,
                matchedText: safeMatch,
                chunkIndex: verdict.chunkIndex,
                evalUs: verdict.evalUs,
                charsStreamed: metrics.charsStreamed,
              });
              console.log(
                `[MIDSTREAM ${meta?.inStreamRetry ? 'IN-STREAM RETRY' : 'ABORT'}] rule=${verdict.ruleId} phase=${verdict.phase} match="${safeMatch}" eval=${verdict.evalUs.toFixed(1)}µs chars=${metrics.charsStreamed}`
              );
            },
          });

          proxyRes.on('end', () => {
            const metrics = session.getSummaryMetrics();
            if (metrics.acknowledgedReferences.length > 0) {
              recordEvent({
                kind: 'acknowledged_pass',
                acknowledgedReferences: metrics.acknowledgedReferences,
                avgEvalUs: metrics.avgEvalUs,
              });
            }
          });
        }
      );

      activeUpstreamReq = upstreamReq;

      upstreamReq.on('error', (err) => {
        if (!clientRes.headersSent) {
          clientRes.writeHead(502, { 'Content-Type': 'application/json' });
          if (!clientRes.writableEnded) {
            clientRes.end(JSON.stringify({ error: err.message }));
          }
          return;
        }
        emitCleanSseStopOnRetryFailure(502, isPrefillContinuation, err.message);
      });

      if (bodyLen > 0) {
        upstreamReq.write(bodyPayload);
      }
      upstreamReq.end();
    }

    const reqChunks = [];
    clientReq.on('data', (chunk) => reqChunks.push(chunk));
    clientReq.on('end', () => {
      rawClientBuffer = Buffer.concat(reqChunks);
      const contentType = String(clientReq.headers['content-type'] || '').toLowerCase();
      const isLikelyJson = !contentType || contentType.includes('application/json') || contentType.includes('+json');
      rawClientBody = isLikelyJson ? rawClientBuffer.toString('utf8') : '';
      const sanitizeTurn1 = clientReq.headers['x-midstream-sanitize-turn1'] === 'true';
      if (rawClientBody && sanitizeTurn1) {
        const sanitized = sanitizeRequestMessages(rawClientBody, compiledRules);
        dispatchUpstreamTurn(sanitized, 0, 0);
      } else {
        dispatchUpstreamTurn(rawClientBuffer, 0, 0);
      }
    });
  });
}

const server = createMidstreamProxyServer();

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`midstream-proxy listening on http://127.0.0.1:${PORT} -> ${UPSTREAM.origin}`);
  });
}

export { server };
