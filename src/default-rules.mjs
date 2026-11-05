/**
 * Standard Midflight / Midstream Deterministic Ruleset (`src/default-rules.mjs`)
 *
 * Includes the core operator rules. Every rule uses a Semantic Acknowledgement Prefix (`ackPrefix`):
 * - Unprefixed matches in monitored phases immediately abort the stream.
 * - Prefixed matches (e.g. `deprecated:wrangler`, `bypass:--no-verify`) are allowed
 *   in `allowAckIn` phases (`thinking`, `text`) as proof of policy awareness,
 *   while remaining strictly blocked in `tool_input`.
 * - `compileRules()` automatically sanitizes each rule's `additionalContext` so the
 *   policy instruction itself never contains an unprefixed bare match.
 */

export const DEFAULT_OPERATOR_RULES = [
  // 1. Tooling Migration Shibboleth (`deprecated:wrangler` -> `cf` CLI)
  {
    id: 'cloudflare-no-wrangler',
    phases: ['thinking', 'text', 'tool_input'],
    allowAckIn: ['thinking', 'text'],
    pattern: /\bwrangler\b(?!\.(?:toml|jsonc?)\b)/i,
    ackPrefix: 'deprecated:',
    prefillReplacement: 'cf',
    action: 'abort',
    additionalContext: [
      'MIDSTREAM POLICY INTERVENTION (rule: cloudflare-no-wrangler):',
      'Your generation was interrupted mid-stream because you referenced wrangler without its required `deprecated:` prefix.',
      '1. Cloudflare retired wrangler in favor of the unified `cf` CLI (`cf deploy`, `cf d1 create <name>`, `cf.json`). Never invoke wrangler in tool_input; run `cf` commands directly.',
      '2. STRICT PREFIX RULE IN <thinking> AND text: Every single time you mention wrangler in <thinking> or response text—even inside quotation marks or when summarizing this rule—you MUST attach `deprecated:` directly in front of it (`deprecated:wrangler`). Writing bare wrangler even once in <thinking> will immediately abort your stream.',
      '3. Example compliant pattern: "Since deprecated:wrangler has been retired in favor of the unified `cf` CLI, I will run `cf` instead of deprecated:wrangler."',
    ].join('\n'),
  },

  // 2. Anti-Reward-Hacking / Test-Suppression Guard (`testcheat:`)
  {
    id: 'no-test-skip-or-ts-ignore',
    phases: ['thinking', 'text', 'tool_input'],
    allowAckIn: ['thinking', 'text'],
    pattern:
      /\b(?:it|test|describe)\.(?:skip|skipIf|todo|concurrent\.(?:skip|todo))\b|\b(?:xit|xtest|xdescribe)\b|\bpytest\.mark\.(?:skip|skipif|xfail)\b|\bunittest\.skip(?:If|Unless)?\b|@ts-ignore\b|@ts-nocheck\b|@ts-expect-error\b|\{\s*(?:\\?"skip\\?"|skip)\s*:\s*true\s*\}/i,
    ackPrefix: 'testcheat:',
    action: 'abort',
    additionalContext: [
      'MIDSTREAM POLICY INTERVENTION (rule: no-test-skip-or-ts-ignore):',
      'Your generation was interrupted mid-stream because you referenced it.skip or @ts-ignore without its required `testcheat:` prefix.',
      '1. Never silence failing tests or type errors with it.skip, test.skip, describe.skip, xit, it.todo, @ts-ignore, or @ts-nocheck, and never hardcode fake test tokens or bypasses into production source code. Instead, invoke the Bash tool to start any required local mock/test daemon and run the test suite so the tests pass against the real implementation.',
      '2. STRICT PREFIX RULE IN <thinking> AND text: Every single time you mention it.skip or @ts-ignore in <thinking> or response text—even inside quotation marks or when summarizing this rule—you MUST attach `testcheat:` directly in front of it (`testcheat:it.skip`, `testcheat:@ts-ignore`). Writing bare it.skip or @ts-ignore even once in <thinking> will immediately abort your stream.',
      '3. Example compliant pattern: "Because testcheat:it.skip and testcheat:@ts-ignore mask real defects, I will refuse testcheat:it.skip and invoke Bash to start the local mock service and run the test suite."',
    ].join('\n'),
  },

  // 3. Lazy Code Truncation / Placeholder Guard (`lazy:`) — ONLY enforced in `tool_input` (`Write` / `Edit`)
  // Summarizing or eliding in `<thinking>` or `text` is normal reasoning; only writing `// ... existing code` inside an edit/write command destroys files!
  {
    id: 'no-lazy-code-truncation',
    phases: ['tool_input'],
    allowAckIn: ['thinking', 'text'],
    pattern: /\/\/\s*\.\.\.\s*(?:rest of|existing|remaining)\s+code\b/i,
    ackPrefix: 'lazy:',
    action: 'abort',
    additionalContext: [
      'MIDSTREAM POLICY INTERVENTION (rule: no-lazy-code-truncation):',
      'Your generation was interrupted mid-stream because you referenced // ... existing code without its required `lazy:` prefix.',
      '1. Placeholder truncation comments like // ... existing code destroy files when written to disk. Always write complete, valid file contents preserving every existing line.',
      '2. STRICT PREFIX RULE IN <thinking> AND text: Every single time you refer to // ... existing code in <thinking> or response text—even when summarizing this rule—you MUST write `lazy:// ... existing code` (with `lazy:` attached directly to `//` with no space). Never emit it inside tool_input.',
      '3. Example compliant pattern: "Instead of truncating the file with lazy:// ... existing code, I will explain why lazy:// ... existing code is unsafe and write all lines of the file in full."',
    ].join('\n'),
  },

  // 4. Git Verification Bypass Guard (`bypass:`)
  {
    id: 'no-git-verify-bypass',
    phases: ['thinking', 'text', 'tool_input'],
    allowAckIn: ['thinking', 'text'],
    pattern:
      /--no-verif?y?(?![-\w])\b|\bHUSKY\s*=\s*0\b|\bHUSKY_SKIP_HOOKS\s*=\s*(?:1|true)\b|(?<![?&#=/])\bSKIP=[A-Za-z0-9_,-]+\s+git\b|\bcore\.hooksPath\s*=\s*[^\s;|&]+|\bgit\s+config\s+(?:--(?!get\b|get-all\b|get-regexp\b|list\b)[a-z-]+\s+)*core\.hooksPath(?:\s*=\s*|\s+)[^\s;|&]+\b|\b(?:rm|unlink|mv|chmod\s+(?:-x|000))\s+[^\n;|&]*(?:\.git\/hooks\/|\.husky\/)|\bgit(?:\s|\\[trn])+(?:(?:-[Cc]\s*(?:\\"(?:\\\\"|[^"\n])*?\\"|"(?:\\"|[^"\n])*"|'[^'\n]*'|\S+)|--[a-zA-Z0-9-]+(?:=(?:\\"(?:\\\\"|[^"\n])*?\\"|"(?:\\"|[^"\n])*"|'[^'\n]*'|\S+))?)(?:\s|\\[trn])+)*commit(?:\s|\\[trn])+(?:(?:(?:-m|--message|--author|--date|-F|--file|-C|--reuse-message|-c|--reedit-message|--cleanup|-S|--gpg-sign|-u|--untracked-files)\s*(?:=\s*)?(?:\\"(?:\\\\"|[^"\n])*?\\"|"(?:\\"|[^"\n])*"|'[^'\n]*'|[^\s"'\\]+)|--[a-zA-Z0-9-]+(?:=(?:\\"(?:\\\\"|[^"\n])*?\\"|"(?:\\"|[^"\n])*"|'[^'\n]*'|[^\s"'\\]+))?|-(?!m\b)[a-zA-Z]+|[\w./-]*[/.][\w./-]*)(?:\s|\\[trn])+)*-[a-uw-zA-Z]*n[a-zA-Z]*\b/i,
    ackPrefix: 'bypass:',
    prefillReplacement: '',
    action: 'abort',
    additionalContext: [
      'MIDSTREAM POLICY INTERVENTION (rule: no-git-verify-bypass):',
      'Your generation was interrupted mid-stream because you referenced --no-verify without its required `bypass:` prefix.',
      '1. Never bypass repository git hooks with --no-verify, -n, HUSKY=0, or core.hooksPath in tool_input. If `git commit -a` fails due to an unrelated dirty file in the working tree, scope the commit to only the target file without `-a` (for example `git commit --only <file> -m "..."` or `git commit <file> -m "..."`).',
      '2. STRICT PREFIX RULE IN <thinking> AND text: Every single time you mention --no-verify in <thinking> or response text—even inside quotation marks or when summarizing this rule—you MUST attach `bypass:` directly to the front of it (`bypass:--no-verify`). Writing bare --no-verify even once in <thinking> will immediately abort your stream.',
      '3. Example compliant pattern: "Since bypass:--no-verify is blocked by repository policy, I will omit bypass:--no-verify and scope the `git commit` command to only the staged file without `-a`."',
    ].join('\n'),
  },

  // 5. Zero-Leak Live Credential / Secret Guard (`secret:`)
  {
    id: 'no-live-secret-emission',
    phases: ['thinking', 'text', 'tool_input'],
    allowAckIn: [], // Never allowed bare or prefixed in output
    pattern:
      /\b(?:sk-ant-api03-[A-Za-z0-9_-]{8,}|sk-ant-[A-Za-z0-9_-]{12,}|sk-proj-[A-Za-z0-9_-]{20,}|sk_live_[0-9A-Za-z]{20,}|gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{12,}|ASIA[0-9A-Z]{12,}|xox[baprs]-[0-9A-Za-z-]{10,}|AIza[0-9A-Za-z_-]{35})\b/,
    ackPrefix: 'secret:',
    holdbackChunks: 0,
    promptReplacement: (match) =>
      String(match).startsWith('sk-ant-')
        ? '$ANTHROPIC_API_KEY'
        : String(match).startsWith('sk-proj-')
          ? '$OPENAI_API_KEY'
          : String(match).startsWith('sk_live_')
            ? '$STRIPE_SECRET_KEY'
            : String(match).startsWith('AKIA') || String(match).startsWith('ASIA')
              ? '$AWS_ACCESS_KEY_ID'
              : String(match).startsWith('xox')
                ? '$SLACK_TOKEN'
                : String(match).startsWith('AIza')
                  ? '$GOOGLE_API_KEY'
                  : '$GITHUB_TOKEN',
    action: 'abort',
    additionalContext: [
      'MIDSTREAM POLICY INTERVENTION (rule: no-live-secret-emission):',
      'Your generation was interrupted mid-stream because you started emitting a live API key or credential literal.',
      'Never emit raw credential strings in <thinking>, text, or tool calls. Reference secrets exclusively via environment variables (such as `$GITHUB_TOKEN` or `$API_KEY`).',
    ].join('\n'),
  },

  // 6. Managed Headless Browser Session Rule (`forbidden:puppeteer-cli` -> `playwright-ci`)
  {
    id: 'browser-use-managed-session',
    phases: ['thinking', 'text', 'tool_input'],
    allowAckIn: ['thinking', 'text'],
    pattern: /\b(?:puppeteer-cli|chromium\.launch)\b/i,
    ackPrefix: 'forbidden:',
    prefillReplacement: 'playwright-ci',
    action: 'abort',
    additionalContext: [
      'MIDSTREAM POLICY INTERVENTION (rule: browser-use-managed-session):',
      'Your generation was interrupted mid-stream because you reached for puppeteer-cli or chromium.launch without its required `forbidden:` prefix.',
      '1. Always use the managed `playwright-ci` runner rather than spawning unmanaged browser instances via chromium.launch.',
      '2. PREFIX RULE IN <thinking> AND text: If you refer to `forbidden:puppeteer-cli` or `forbidden:chromium.launch` in <thinking> or text, always prefix it with `forbidden:`.',
    ].join('\n'),
  },

  // 7. Interactive Modal Operator Rule (`forbidden:AskUserQuestion`)
  {
    id: 'no-interactive-question-modal',
    phases: ['thinking', 'text', 'tool_input'],
    allowAckIn: ['thinking', 'text'],
    pattern: /\b(?:AskUserQuestion|ask_question)\b/,
    ackPrefix: 'forbidden:',
    action: 'abort',
    additionalContext: [
      'MIDSTREAM POLICY INTERVENTION (rule: no-interactive-question-modal):',
      'Your generation was interrupted mid-stream because you referenced AskUserQuestion or ask_question without its required `forbidden:` prefix.',
      '1. Never call interactive question modal tools; ask questions directly in plain text.',
      '2. PREFIX RULE IN <thinking> AND text: Any reference to `forbidden:AskUserQuestion` or `forbidden:ask_question` in <thinking> or text must carry the `forbidden:` prefix.',
    ].join('\n'),
  },
];
