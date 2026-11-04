import { describe, expect, it } from 'vitest';
import { egressPolicy } from '../src/providers/kubernetes.js';

describe('egressPolicy', () => {
  it('is absent when egress is unrestricted', () => expect(egressPolicy('ns', 'all', [])).toBeNull());
  it('none: same namespace only', () => expect(egressPolicy('ns', 'none', [])!.spec!.egress).toEqual([{ to: [{ podSelector: {} }] }]));
  it('dns-only: adds cluster DNS', () => {
    const rules = egressPolicy('ns', 'dns-only', [])!.spec!.egress!;
    expect(rules).toHaveLength(2);
    expect(rules[1]!.ports!.map((p) => p.port)).toEqual([53, 53]);
  });
  it('allowlist: adds the CIDRs', () => {
    const p = egressPolicy('ns', 'allowlist', ['10.0.0.0/8', '1.2.3.4/32'])!;
    expect(p.metadata).toEqual({ name: 'blackbox-egress', namespace: 'ns' });
    expect(p.spec!.egress![2]).toEqual({ to: [{ ipBlock: { cidr: '10.0.0.0/8' } }, { ipBlock: { cidr: '1.2.3.4/32' } }] });
  });
});
