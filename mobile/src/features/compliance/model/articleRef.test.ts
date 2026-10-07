/**
 * The legal reference port: REGULATION_LABEL pinned textually to
 * ArticleRef.jsx (which imports React), formatRef on the web test's fixtures.
 */

import fs from 'node:fs';

import { AGENT_HUB_SRC } from '@/shared/testing/webModule';

import { formatArticleRef, formatRef, REGULATION_LABEL, regulationLabel, refsLine } from './articleRef';

const t = (_k: string, en: string, p?: Record<string, unknown>) => en.replace(/\{(\w+)\}/g, (_m, k: string) => String(p?.[k]));
const nl = (k: string, en: string, p?: Record<string, unknown>) => (k === 'compliance.reg_gdpr' ? 'AVG' : t(k, en, p));

it('keeps the web table of regulation names', () => {
    const src = fs.readFileSync(`${AGENT_HUB_SRC}/components/admin/compliance/shared/ArticleRef.jsx`, 'utf8');
    const web = [...src.matchAll(/^\s+([A-Z0-9_]+): Object\.freeze\(\{ key: '([^']+)', en: '([^']*)' \}\)/gm)].map((m) => [m[1], m[2], m[3]]);
    const mine = Object.entries(REGULATION_LABEL).map(([code, v]) => [code, v.key, v.en]);
    expect(web.length).toBeGreaterThan(5);
    expect(mine).toEqual(web);
});

it.each([
    ['12', 'Art. 12'],
    ['50(2)', 'Art. 50(2)'],
    [28, 'Art. 28'],
    [' 33 ', 'Art. 33'],
    ['A.5.20', 'A.5.20'],
    ['cl 6.1', 'cl 6.1'],
    ['Art. 21(2)', 'Art. 21(2)'],
    ['Annex I 2(1)', 'Annex I 2(1)'],
    ['Recital 27', 'Recital 27'],
    ['Q-3', 'Q-3'],
    ['', ''],
    [null, ''],
    [undefined, ''],
])('formatRef(%s) → %s', (ref, out) => {
    expect(formatRef(ref)).toBe(out);
});

it('names the regulation, through aliases, translated', () => {
    expect(regulationLabel('GDPR', t)).toBe('GDPR');
    expect(regulationLabel('gdpr', t)).toBe('GDPR');
    expect(regulationLabel('ISO', t)).toBe('ISO');
    expect(regulationLabel('product_liability', t)).toBe('PLD');
    expect(regulationLabel('CUSTOM', t)).toBe('');
    expect(regulationLabel('WHATEVER', t)).toBe('');
    expect(formatArticleRef('GDPR', '12', nl)).toBe('AVG Art. 12');
    expect(formatArticleRef('AIA', '50', t)).toBe('AI Act Art. 50');
    expect(formatArticleRef('CUSTOM', 'Q-3', t)).toBe('Q-3');
});

it('shows at most `max` refs and counts the rest', () => {
    const refs = [{ regulation: 'GDPR', ref: '33' }, { regulation: 'NIS2', ref: 'Art. 23' }, { regulation: 'ISO27001', ref: 'A.5.24' }];
    expect(refsLine(refs, 2, t)).toBe('GDPR Art. 33 · NIS2 Art. 23 · +1');
    expect(refsLine(refs.slice(0, 1), 2, t)).toBe('GDPR Art. 33');
    expect(refsLine(null, 2, t)).toBe('');
});
