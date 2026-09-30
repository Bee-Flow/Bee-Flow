/**
 * The New form's rules: when Start is allowed, the exact create body (the
 * web's, field for field), the tiers it offers and the language it builds in.
 */

import { buildLocale, canStart, createBody, depthTiers, folderProblem, initialForm, tierEnglish, tierKey } from './newPlaybook';
import type { Recipe } from './types';

const recipe = (over: Partial<Recipe> = {}): Recipe => ({
    title: 'Contract tracker',
    description: 'Reads contracts',
    phases: [{ key: 'table', label: 'Table' }],
    fields: [{ key: 'supplier', name: 'Supplier', type: 'text' }],
    inputs: [{ key: 'folderPath', label: 'Folder', kind: 'folder', default: '/Contracts', placeholder: null }],
    needsApprover: false,
    warnings: [],
    raw: { title: 'Contract tracker', phases: [] },
    ...over,
});

describe('the New form', () => {
    it('opens on the recipe’s title, a new table, Fast and the input defaults', () => {
        expect(initialForm(recipe())).toEqual({ title: 'Contract tracker', tableMode: 'new', datatableId: '', inputs: { folderPath: '/Contracts' }, tier: 'fast', approverGroupId: '' });
        expect(initialForm(null).title).toBe('');
    });

    it('wants an absolute folder, a name, and a table when "existing" is chosen', () => {
        const r = recipe();
        const form = initialForm(r);
        expect(canStart(r, form)).toBe(true);
        expect(canStart(null, form)).toBe(false);
        expect(canStart(r, { ...form, title: '  ' })).toBe(false);
        expect(canStart(r, { ...form, inputs: { folderPath: 'Contracts' } })).toBe(false);
        expect(canStart(r, { ...form, tableMode: 'existing' })).toBe(false);
        expect(canStart(r, { ...form, tableMode: 'existing', datatableId: 'dt1' })).toBe(true);
        expect(folderProblem({ key: 'x', label: 'x', kind: 'text', default: null, placeholder: null }, '')).toBe(false);
        expect(folderProblem({ key: 'x', label: 'x', kind: 'folder', default: null, placeholder: null }, `/${'a'.repeat(300)}`)).toBe(true);
    });

    it('sends the composed document back with the options the web sends', () => {
        const r = recipe();
        expect(createBody(r, { ...initialForm(r), title: ' Tracker ', inputs: { folderPath: ' /C ' }, tier: 'auto' }, { description: ' Read my contracts ', locale: 'nl' })).toEqual({
            recipe: r.raw,
            title: 'Tracker',
            options: {
                tableMode: 'new',
                datatableId: undefined,
                inputs: { folderPath: '/C' },
                folderPath: '/C',
                tier: 'auto',
                locale: 'nl',
                approverGroupId: undefined,
                ask: 'Read my contracts',
            },
        });
        const noTable = recipe({ fields: null, inputs: [] });
        expect(createBody(noTable, initialForm(noTable), { description: '', locale: 'en' }).options).toMatchObject({ tableMode: undefined, ask: undefined, inputs: {} });
    });
});

describe('tiers', () => {
    it('offers the configured depth tiers in the web’s order, else Fast and Auto', () => {
        expect(depthTiers(null)).toEqual(['fast', 'auto']);
        expect(depthTiers({ auto: {} })).toEqual(['fast', 'auto']);
        expect(depthTiers({ fast: { modelId: 'm' }, thinking: { modelId: 'm2' }, standard: { modelId: 'm3' }, deep_thinking: { modelId: 'm4' } })).toEqual(['auto', 'fast', 'thinking']);
        expect(depthTiers({ thinking: {} })).toEqual(['fast', 'auto']);
    });

    it('names pro as deep thinking', () => {
        expect(tierKey('pro')).toBe('tier.deep_thinking');
        expect(tierKey('fast')).toBe('tier.fast');
        expect(tierEnglish('thinking')).toBe('Think');
        expect(tierEnglish('custom')).toBe('custom');
    });
});

describe('buildLocale', () => {
    const anchors = { 'playbooks.new.title': 'Nieuw', 'playbooks.new.describe_label': 'Wat', 'playbooks.phase.table': 'Tabel' };
    it('builds in the language on screen only when the playbook screens are translated', () => {
        expect(buildLocale('nl', anchors)).toBe('nl');
        expect(buildLocale('nl', { 'playbooks.new.title': 'Nieuw' })).toBe('en');
        expect(buildLocale('nl', {})).toBe('en');
        expect(buildLocale('en', anchors)).toBe('en');
    });
});
