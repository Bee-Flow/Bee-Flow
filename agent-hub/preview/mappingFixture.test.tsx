import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import NodeDetailView from '../src/components/automation/Builder/NodeDetailView';
import { CATALOG, SCENARIOS, definitionFor } from './mappingFixture';

/**
 * The mapping preview's scenarios, rendered in the real step drawer, with the
 * check every mapping screenshot is paired with: no path, no `{{ }}`, no
 * `[*]` and no `loop.` anywhere a person can read. And per scenario, the one
 * state it exists to show.
 */

// The words of the mapping grammar a person must never meet in the drawer.
const JARGON = /\{\{|\[\*\]|steps\.|loop\./;

const realFetch = globalThis.fetch;
beforeAll(() => {
    // Every request answers from the fixture, as on the preview page.
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const body = /\/automation\/catalog(\?|$)/.test(url) ? CATALOG : /forms/.test(url) ? { forms: [] } : {};
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
});
afterAll(() => { vi.stubGlobal('fetch', realFetch); });

function renderScenario(name: string) {
    const { definition, step } = definitionFor(name);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
        <QueryClientProvider client={qc}>
            <NodeDetailView
                step={step}
                runStep={null}
                runSteps={[]}
                definition={definition}
                rootDefinition={definition}
                automation={{ id: 'preview', definition }}
                catalog={CATALOG}
                onSaveStep={async () => {}}
                validation={{ errors: [], warnings: [] }}
                modelTiers={{}}
                onClose={() => {}}
            />
        </QueryClientProvider>,
    );
    return screen.getByTestId('ndv-drawer');
}

/** The value slot of one parameter of the Gmail step. */
const param = (key: string) => screen.getByTestId(`param-${key}`);

describe('mapping preview scenarios in the step drawer', () => {
    beforeEach(cleanup);

    it.each(Object.keys(SCENARIOS))('%s shows no mapping jargon', async (name) => {
        const drawer = renderScenario(name);
        await waitFor(() => expect(within(drawer).getByTestId('param-to')).toBeTruthy());
        expect(drawer.textContent).not.toMatch(JARGON);
        // Typed values are on screen too, in the inputs.
        for (const input of Array.from(drawer.querySelectorAll('input, textarea'))) {
            expect((input as HTMLInputElement).value).not.toMatch(JARGON);
        }
    });

    it('single: the legacy ref is a chip with the customer\'s e-mail as example', async () => {
        renderScenario('single');
        const chip = await waitFor(() => within(param('to')).getByTestId('value-chip'));
        expect(chip.textContent).toContain('Email of customer');
        expect(chip.textContent).toContain('anna@voorbeeld.nl');
    });

    it('pick-list-in-text: "Comes as text: all 4, one per line."', async () => {
        renderScenario('pick-list-in-text');
        const body = await waitFor(() => param('body'));
        expect(within(body).getByTestId('pick-sentence').textContent).toContain('Comes as text: all 4, one per line.');
        expect(within(body).getByTestId('value-chip').textContent).toContain('· 4');
    });

    it('pick-column-choice: no column matches, the question is amber; picked, it names the column', async () => {
        renderScenario('pick-column-choice');
        const sentence = await waitFor(() => within(param('cc')).getByTestId('pick-sentence'));
        expect(sentence.getAttribute('data-tone')).toBe('amber');
        cleanup();
        renderScenario('pick-column-picked');
        const picked = await waitFor(() => within(param('cc')).getByTestId('pick-sentence'));
        expect(picked.getAttribute('data-tone')).toBe('muted');
        expect(within(picked).getByRole('combobox')).toHaveProperty('value', 'E-mail');
    });

    it('pick-many-into-number: "Only the first of 2.", in amber', async () => {
        renderScenario('pick-many-into-number');
        const sentence = await waitFor(() => within(param('priority')).getByTestId('pick-sentence'));
        expect(sentence.getAttribute('data-tone')).toBe('amber');
        expect(sentence.textContent).toContain('Only the first of 2.');
    });

    it('pick-stale: the amber chip says the value is gone', async () => {
        renderScenario('pick-stale');
        const chip = await waitFor(() => within(param('to')).getByTestId('value-chip'));
        expect(chip.getAttribute('data-state')).toBe('stale');
        expect(chip.textContent).toContain('No longer available');
    });

    it('repeat-current-item: the current contact sits on top of Comes in and its values read "of this contact"', async () => {
        const drawer = renderScenario('repeat-current-item');
        const chip = await waitFor(() => within(param('to')).getByTestId('value-chip'));
        expect(chip.textContent).toContain('E-mail (of this contact)');
        // The first contact's value, as the run gives it for that item.
        expect(chip.textContent).toContain('anna@voorbeeld.nl');
        const input = within(drawer).getByTestId('ndv-col-input').parentElement as HTMLElement;
        const first = within(input).getAllByTestId('input-group')[0];
        expect(first.textContent).toContain('Current contact');
        expect(first.textContent).toContain('anna@voorbeeld.nl');
    });

    it('legacy-formula and list-in-text: the grey Formula chip, the template in words', async () => {
        renderScenario('legacy-formula');
        const chip = await waitFor(() => within(param('subject')).getByTestId('value-chip'));
        expect(chip.getAttribute('data-state')).toBe('formula');
        cleanup();
        renderScenario('list-in-text');
        const body = await waitFor(() => within(param('body')).getByTestId('value-chip'));
        expect(body.getAttribute('data-state')).toBe('formula');
    });
});
