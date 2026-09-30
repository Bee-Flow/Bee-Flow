/**
 * TEXTUAL lockstep: the DLP review's colours and certainty words against the
 * web's config/dlpCategoryColors.ts and piiCategories.ts.
 */

import fs from 'node:fs';

import { AGENT_HUB_SRC } from '@/shared/testing/webModule';

import { bandAlpha, categorySlot, confidenceWords } from './dlpCategories';

const COLORS = fs.readFileSync(`${AGENT_HUB_SRC}/config/dlpCategoryColors.ts`, 'utf8');
const CATEGORIES = fs.readFileSync(`${AGENT_HUB_SRC}/config/piiCategories.ts`, 'utf8');

it('gives each group the slot the web gives it, and the rest the eighth', () => {
    const table = CATEGORIES.slice(CATEGORIES.indexOf('PII_GROUP_COLOR_TOKEN'));
    const slots = [...table.slice(0, table.indexOf('};')).matchAll(/'?([A-Za-z /]+)'?: 'pii-cat-(\d)'/g)].map((m) => [(m[1] ?? '').trim(), Number(m[2]) - 1]);
    const firstOf: Record<string, string> = {
        Personal: 'Person',
        Contact: 'Email',
        Financial: 'CreditCardNumber',
        Identity: 'PassportNumber',
        Digital: 'IPAddress',
        Organization: 'Organization',
        'EU / Netherlands': 'Medication',
    };
    for (const [group, slot] of slots) expect([group, categorySlot(firstOf[group as string])]).toEqual([group, slot]);
    expect(CATEGORIES).toContain("PII_OTHER_COLOR_TOKEN = 'pii-cat-8'");
    expect(categorySlot('UserMarked')).toBe(7);
});

it('fades a finding by band exactly as the web does', () => {
    const fn = COLORS.slice(COLORS.indexOf('function alphaForBand'));
    const web = [...fn.slice(0, fn.indexOf('\n}')).matchAll(/'(\d+)%'/g)].map((m) => Number(m[1]));
    expect([bandAlpha('medium'), bandAlpha('low'), bandAlpha('high')]).toEqual(web);
    expect(bandAlpha(null)).toBe(bandAlpha('high'));
});

it('names certainty in the web’s words and keys, in its order', () => {
    const fn = COLORS.slice(COLORS.indexOf('export function confidenceLabel'));
    const web = [...fn.slice(0, fn.indexOf('\n}')).matchAll(/t\('([^']+)', '([^']+)'\)/g)].map((m) => ({ i18nKey: m[1], en: m[2] }));
    const mine = [
        confidenceWords('manual', null),
        confidenceWords('custom', null),
        confidenceWords('pii', 'high'),
        confidenceWords('pii', 'medium'),
        confidenceWords('pii', 'low'),
        confidenceWords('pii', null),
    ];
    expect(mine).toEqual(web);
});
