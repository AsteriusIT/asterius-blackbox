/**
 * Minimal secret scanner for the lines a pull request adds (gitleaks-style rules, no external binary).
 * Used as a gate before the agent opens a PR: the prompt says "never commit secrets", this enforces it.
 */

export interface SecretFinding {
  file: string;
  line: number;
  rule: string;
  preview: string;
}

const RULES: [string, RegExp][] = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['aws-access-key', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['openai-key', /\bsk-(proj-)?[A-Za-z0-9]{32,}\b/],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ['azure-storage-key', /AccountKey=[A-Za-z0-9+/=]{40,}/],
  ['connection-string-password', /\b[a-z][a-z0-9+]*:\/\/[^\s:/@]+:[^\s@/]{6,}@[^\s]+/i],
  ['generic-secret', /\b(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b["']?\s*[:=]\s*["'][^"'\s]{12,}["']/i],
];

/** Obvious placeholders and env lookups are not secrets. */
const PLACEHOLDER = /\$\{|process\.env|os\.environ|getenv|<[a-z_-]+>|changeme|change-me|example|placeholder|dummy|x{6,}|\*{6,}|your[_-]/i;

const redact = (s: string) => (s.length <= 8 ? '****' : `${s.slice(0, 4)}…${s.slice(-2)}`);

/** Scan a unified diff (`git diff`), reporting only added lines. */
export function scanDiff(diff: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  let file = '';
  let line = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      file = raw.slice(4).replace(/^b\//, '');
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith('+')) {
      const text = raw.slice(1);
      for (const [rule, re] of RULES) {
        const m = re.exec(text);
        if (m && !PLACEHOLDER.test(m[0])) {
          findings.push({ file, line, rule, preview: text.replace(m[0], redact(m[0])).trim().slice(0, 160) });
          break;
        }
      }
      line++;
    } else if (!raw.startsWith('-') && !raw.startsWith('\\')) line++;
  }
  return findings;
}
