import { describe, expect, it } from 'vitest';
import { skipSentence } from './RunAutomationEditor';
import { SKIP_REASONS } from './testPayload';
import type { TranslateFn } from '@/hooks/useTranslation';

const t: TranslateFn = (_key, fallback, params) => {
    const text = typeof fallback === 'string' ? fallback : '';
    const values = params || {};
    return text.replace(/\{(\w+)\}/g, (_m, name: string) => String(values[name] ?? ''));
};

describe('skipSentence', () => {
    it('names the parameter and its field, with one sentence per reason', () => {
        expect(skipSentence(t, { param: 'invoice', field: 'upload', reason: SKIP_REASONS.FILE }))
            .toBe('invoice (upload) — a file cannot be sent from here, so the automation runs without it.');
        expect(skipSentence(t, { param: 'amount', field: null, reason: SKIP_REASONS.NO_SCREEN })).toMatch(/^amount — that form is not on the canvas/);
        expect(skipSentence(t, { param: 'amount', field: null, reason: SKIP_REASONS.NO_VALUE })).toMatch(/has no field by that name/);
        expect(skipSentence(t, { param: 'amount', field: null, reason: SKIP_REASONS.NO_MAPPING })).toMatch(/has no row for it/);
        expect(skipSentence(t, { param: 'amount', field: null, reason: SKIP_REASONS.UNMAPPED })).toMatch(/nothing is wired to it/);
    });
});
