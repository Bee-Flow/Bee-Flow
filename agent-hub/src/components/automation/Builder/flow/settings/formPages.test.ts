import { describe, it, expect } from 'vitest';
import { collectFormPages } from './formPages';

const form = (title: string) => ({ title, fields: [] });

describe('collectFormPages', () => {
    it('returns nothing without a definition', () => {
        expect(collectFormPages(null)).toEqual([]);
    });

    it('lists the form trigger first, then pages in flow order, marking the ending', () => {
        const pages = collectFormPages({
            trigger: { id: 't', type: 'trigger', kind: 'form', form: form('Start') },
            steps: [
                { id: 'end', type: 'form_page', mode: 'ending', form: form('Bye') },
                { id: 'mid', type: 'form_page', mode: 'input', label: 'Details', form: form('More') },
                { id: 'ai', type: 'ai', form: undefined },
            ],
            edges: [{ from: 't', to: 'mid' }, { from: 'mid', to: 'ai' }, { from: 'ai', to: 'end' }],
        });
        expect(pages.map(p => [p.id, p.kind, p.label])).toEqual([
            ['t', 'trigger', 'Start'],
            ['mid', 'page', 'Details'],
            ['end', 'ending', 'Bye'],
        ]);
        expect(pages[0].bindingBase).toBe('trigger.output');
        expect(pages[0].allowVariables).toBe(false);
        expect(pages[1].bindingBase).toBe('steps.mid.output');
        expect(pages[1].allowVariables).toBe(true);
    });

    it('appends a page the flow does not reach, and skips a non-form trigger', () => {
        const pages = collectFormPages({
            trigger: { id: 't', type: 'trigger', kind: 'webhook' },
            steps: [{ id: 'p', type: 'form_page', form: form('Lonely') }],
            edges: [],
        });
        expect(pages.map(p => p.id)).toEqual(['p']);
    });
});
