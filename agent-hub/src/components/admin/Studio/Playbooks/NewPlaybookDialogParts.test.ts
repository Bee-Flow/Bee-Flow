import { describe, expect, it } from 'vitest';
import { DESCRIBE_ID, composeErrorMessage, createPayloadFor, type CreatePayloadArgs } from './NewPlaybookDialogParts';
import { depthTierKeys } from './useNewPlaybookData';
import type { TranslateFn } from '@/hooks/useTranslation';

const t: TranslateFn = (_key, fallback) => (typeof fallback === 'string' ? fallback : '');

const base: CreatePayloadArgs = {
    recipe: { id: 'invoices', inputs: [{ key: 'folderPath', default: '/Invoices' }] },
    recipeId: 'invoices',
    composed: null,
    title: '  Invoices  ',
    hasTable: true,
    tableMode: 'new',
    datatableId: 'dt1',
    inputs: { folderPath: ' /Invoices ', stray: 'x' },
    tier: 'fast',
    locale: 'en',
    approverGroupId: '',
    description: 'ignored for a built-in recipe',
};

describe('createPayloadFor', () => {
    it('sends a built-in recipe by id with trimmed inputs', () => {
        expect(createPayloadFor(base)).toEqual({
            recipeId: 'invoices',
            title: 'Invoices',
            options: {
                tableMode: 'new', datatableId: undefined, inputs: { folderPath: '/Invoices' }, folderPath: '/Invoices',
                tier: 'fast', locale: 'en', approverGroupId: undefined, ask: undefined,
            },
        });
    });

    it('sends a described recipe whole, with the ask and the existing table', () => {
        const composed = { id: 'ai', inputs: [] };
        const out = createPayloadFor({
            ...base, recipe: composed, recipeId: DESCRIBE_ID, composed, tableMode: 'existing', approverGroupId: 'g1', description: ' build it ',
        });
        expect(out).toHaveProperty('recipe', composed);
        expect(out).not.toHaveProperty('recipeId');
        expect(out.options).toMatchObject({ tableMode: 'existing', datatableId: 'dt1', approverGroupId: 'g1', ask: 'build it', inputs: {} });
    });

    it('leaves the table options out when the recipe has no table', () => {
        expect(createPayloadFor({ ...base, hasTable: false, tableMode: 'existing' }).options)
            .toMatchObject({ tableMode: undefined, datatableId: undefined });
    });
});

describe('composeErrorMessage', () => {
    it('explains a truncated answer in the GUI language', () => {
        expect(composeErrorMessage(Object.assign(new Error('raw'), { code: 'compose_truncated' }), t)).toMatch(/longer than the model can write/);
    });

    it('appends the server findings to the message', () => {
        const e = Object.assign(new Error('Invalid recipe.'), { body: { errors: [{ message: 'no phases' }, {}, { message: 'no table' }] } });
        expect(composeErrorMessage(e, t)).toBe('Invalid recipe. no phases no table');
    });

    it('falls back when there is no message', () => {
        expect(composeErrorMessage(null, t)).toMatch(/could not write a runnable playbook/);
    });
});

describe('depthTierKeys', () => {
    it('keeps the fallback pair when only auto is configured', () => {
        expect(depthTierKeys(null)).toEqual(['fast', 'auto']);
        expect(depthTierKeys({ auto: {} })).toEqual(['fast', 'auto']);
    });

    it('lists the configured depth tiers and drops kinds of work', () => {
        expect(depthTierKeys({ fast: { modelId: 'm1' }, swarm: { modelId: 'm2' } })).toEqual(['auto', 'fast']);
    });
});
