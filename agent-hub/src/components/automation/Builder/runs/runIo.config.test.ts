import { describe, expect, it } from 'vitest';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import { configFields } from './runIo';
import { buildRunStepLabelMap, buildRunStepMap } from '../flow/displayHelpers';

// English fallback with {param} interpolation, like the app's t().
const t: TranslateFn = (_key, fallback, params) => {
    const text = typeof fallback === 'string' ? fallback : _key;
    const p = (typeof fallback === 'object' ? fallback : params) || {};
    return text.replace(/\{(\w+)\}/g, (_, k) => String((p as Record<string, unknown>)[k] ?? ''));
};

const DEF = {
    trigger: { id: 'trg', type: 'trigger', kind: 'manual', label: 'Start' },
    steps: [
        { id: 'c1', type: 'code', label: 'Test data', code: 'x', inputs: {} },
        {
            id: 'a1', type: 'integration_action', label: 'Create note', tool: 'nextcloud_notes_create',
            inputs: {
                title: { kind: 'ref', path: 'steps.c1.output.result.subject' },
                content: { kind: 'template', value: 'Lines: {{steps.c1.output.result.lines}}' },
                category: { kind: 'literal', value: 'Work' },
                apiKey: { kind: 'literal', value: 'sk-123' },
                token: { kind: 'ref', path: 'secrets.NC_TOKEN' },
            },
            forEach: { overRef: 'steps.c1.output.result.lines', itemVar: 'line' },
        },
        { id: 'n1', type: 'notification', label: 'Notify me', title: 'Done', body: 'Hi {{trigger.output.name}}', channels: ['notification', 'email'] },
        { id: 'f1', type: 'call_layer', layerKey: 'mail', label: 'Mail' },
    ],
    layers: { mail: { trigger: { id: 'trg', type: 'trigger' }, steps: [{ id: 's2', type: 'integration_action', tool: 'gmail_search', label: 'Search', inputs: { q: { kind: 'literal', value: 'invoice' } } }] } },
};

describe('configFields: what a step was set up to do in this run (BFSF-456)', () => {
    const labels = buildRunStepLabelMap(DEF);
    const byId = buildRunStepMap(DEF);

    it('an action lists its action and inputs as the editor chips read them', () => {
        const rows = configFields(t, byId.get('a1'), labels);
        const by = Object.fromEntries(rows.map(r => [r.key, r.preview]));
        expect(rows[0]).toMatchObject({ label: 'Action', preview: 'Nextcloud Notes Create' });
        expect(by.title).toBe('Test data ▸ Subject');
        expect(by.content).toMatch(/^Lines: Test data ▸/);
        expect(by.category).toBe('Work');
        expect(rows.find(r => r.key === 'forEach')).toMatchObject({ label: 'Once for each' });
    });

    it('never shows a secret, by key or by reference', () => {
        const by = Object.fromEntries(configFields(t, byId.get('a1'), labels).map(r => [r.key, r.preview]));
        expect(by.apiKey).toBe('hidden');
        expect(by.token).toBe('hidden');
        expect(JSON.stringify(by)).not.toContain('sk-123');
    });

    it('a step without inputs lists its own settings; a word list reads as words', () => {
        const by = Object.fromEntries(configFields(t, byId.get('n1'), labels).map(r => [r.label, r.preview]));
        expect(by).toMatchObject({ Title: 'Done', Channels: 'notification, email' });
        expect(by.Body).toMatch(/^Hi Trigger/);
    });

    it('finds a flowlet step under the id the runner records', () => {
        const rows = configFields(t, byId.get('f1/s2'), labels);
        expect(rows.map(r => r.preview)).toEqual(['Gmail Search', 'invoice']);
        expect(configFields(t, null)).toEqual([]);
    });
});
