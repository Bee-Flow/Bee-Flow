import { describe, it, expect } from 'vitest';

import type { TranslateFn } from '../../../../../../../hooks/useTranslation';
import type { Finding } from '../shieldFindings';
import { findingCopy } from './findingCopy';

/** The English fallback with its {placeholders} filled, like the real t(). */
const t: TranslateFn = (_key, fallback, params) => {
    let out = typeof fallback === 'string' ? fallback : _key;
    for (const [k, v] of Object.entries(params || {})) out = out.replaceAll(`{${k}}`, String(v));
    return out;
};
const fmt = (n: number) => String(n);
const copy = (f: Partial<Finding> & Pick<Finding, 'id' | 'vars'>) => findingCopy({ tone: 'warn', ...f }, t, fmt);

describe('findingCopy', () => {
    it('tool calls: every sentence the figures back, and none they do not', () => {
        const full = copy({ id: 'tool_pii', vars: { n: 83, outside: 26, hostA: 'a.nl', hostB: 'b.com', held: 0, total: 21 } });
        expect(full.title).toBe('83 tool calls carried personal data out unchanged');
        expect(full.body).toBe('Tools hold back 0 of 21 kinds. 26 of these went to a server outside Europe. Most went to a.nl and b.com.');

        const bare = copy({ id: 'tool_pii', vars: { n: 2, outside: 0, hostA: 'a.nl', hostB: '', held: -1, total: -1 } });
        expect(bare.body).toBe('Most went to a.nl.');
    });

    it('a global network, named or not, and never a claim about where the service runs', () => {
        expect(copy({ id: 'via_network', vars: { n: 12, network: 'Cloudflare' } }).title).toBe('12 calls went through Cloudflare');
        const unnamed = copy({ id: 'via_network', vars: { n: 3, network: '' } });
        expect(unnamed.title).toBe('3 calls went through a global network');
        expect(unnamed.body).toMatch(/where the service behind it runs is not/);
    });

    it('unplaced calls name the hosts, and how many more', () => {
        expect(copy({ id: 'unknown', vars: { n: 5, hosts: 'smtp', more: 0, pii: 4 } }).body)
            .toBe('No known country for smtp. Calls to them carried personal data 4 times.');
        expect(copy({ id: 'unknown', vars: { n: 9, hosts: 'smtp, ftp', more: 2, pii: 0 } }).body)
            .toBe('No known country for smtp, ftp and 2 more.');
    });

    it('keeps the wording of the old alerts', () => {
        expect(copy({ id: 'low_score', vars: { score: 31 } }).body).toBe('Only 31 of 100 calls stayed in Europe or on your own servers.');
        expect(copy({ id: 'many_catches', vars: { n: 40 } }).title).toBe('The shield is catching a lot of personal data');
        expect(copy({ id: 'protected', tone: 'good', vars: { n: 55 } }).title).toBe('Nothing got past the shield unprotected');
    });
});
