import { describe, expect, it } from 'vitest';
import { scanDiff } from '../src/security/secrets.js';

const diff = (lines: string[]) => ['diff --git a/src/x.ts b/src/x.ts', '--- a/src/x.ts', '+++ b/src/x.ts', '@@ -10,2 +10,9 @@', ...lines].join('\n');

describe('scanDiff', () => {
  it.each([
    ['private-key', '-----BEGIN RSA PRIVATE KEY-----'],
    ['aws-access-key', 'const k = "AKIAIOSFODNN7ABCDEFG";'],
    ['github-token', 'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789AB'],
    ['anthropic-key', 'ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz'],
    ['slack-token', 'xoxb-1234567890-abcdefghij'],
    ['connection-string-password', 'DATABASE_URL=postgres://app:s3cretPass@db:5432/app'],
    ['generic-secret', 'const apiKey = "a8f5f167f44f4964e6c998dee827110c";'],
    ['generic-secret', '"client_secret": "Zx9-very-real-secret-value"'],
  ])('flags %s', (rule, line) => {
    const [f] = scanDiff(diff([` context`, `+${line}`]));
    expect(f).toMatchObject({ file: 'src/x.ts', line: 11, rule });
    expect(f!.preview).toMatch(/…|\*\*\*\*/);
  });

  it.each([
    'const apiKey = process.env.API_KEY;',
    'password: "${DB_PASSWORD}"',
    'const secret = "changeme-in-production";',
    'DATABASE_URL=postgres://app:<password>@db/app',
    'api_key = "your-api-key-here"',
    'const token = req.headers.authorization;',
  ])('ignores %s', (line) => expect(scanDiff(diff([`+${line}`]))).toEqual([]));

  it('ignores removed lines and tracks line numbers across hunks', () => {
    const d = diff(['-const old = "AKIAIOSFODNN7ABCDEFG";', '+ok', ' ctx', '+AKIAIOSFODNN7ABCDEFG']);
    expect(scanDiff(d)).toEqual([expect.objectContaining({ line: 12, rule: 'aws-access-key' })]);
  });
});
