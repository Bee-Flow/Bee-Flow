import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render as rtlRender, screen, type RenderOptions } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * THE THREAD BETWEEN THE SCREEN AND THE TEST BUTTON — end-to-end, in the mode in which that button
 * really exists.
 *
 * The store (ScreenValuesContext) and the payload builder (inspector/testPayload) are both thoroughly
 * tested on their own, and the LOCKSTEP test alongside them proves that AppForm publishes under the key
 * that the inspector reads. What NOBODY proved was the thread between them:
 *
 *   1. `Canvas` passes `registerFormValue` through to its AppRenderer — and did so only in the PREVIEW
 *      branch. The inspector, and therefore "Test with what is on screen", exists only in EDIT mode
 *      (`mode === 'edit' && editorView === 'edit'`), so the store in precisely that mode never received
 *      anything: every {kind:'field'} parameter dropped out with the reason "that form is not on the
 *      canvas" — about a form that was visibly there.
 *   2. `screenValues?.publish(...)` in that same callback. Removing that line left 780 tests in editor/
 *      and inspector/ green.
 *
 * Hence this test: the REAL shell, the REAL canvas in edit mode, the REAL store. The inspector is replaced
 * by a probe that reads the store the way ActionsSection does — that is the only piece mocked here,
 * because the question is not what the inspector draws but what it gets to read.
 */

const render = (ui: ReactElement, options?: RenderOptions) => rtlRender(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        {ui}
    </QueryClientProvider>,
    options,
);

vi.mock('../studioAppsApi', () => {
    const api = {
        saveDefinition: vi.fn().mockResolvedValue({ ok: true, version: 2, warnings: [], repairs: [] }),
        updateApp: vi.fn().mockResolvedValue({}),
        publish: vi.fn().mockResolvedValue({}),
        listVersions: vi.fn().mockResolvedValue({ versions: [] }),
        restoreVersion: vi.fn().mockResolvedValue({}),
        getApp: vi.fn().mockResolvedValue({}),
    };
    return { studioAppsApi: api, default: api };
});

// De sonde staat op de plek van de inspector en leest de store langs dezelfde
// weg als ActionsSection: `useScreenValues()` → `readForm(<formuliernaam>)`.
vi.mock('../inspector/InspectorPanel', async () => {
    // Async factory: `vi.mock` is hoisted above the imports, so the real context is fetched in here
    // instead of being read from an enclosing binding.
    const { useScreenValues } = await import('./ScreenValuesContext');
    const { useState } = await import('react');
    return {
        // A named component: the eslint hooks rule does not recognise an anonymous arrow function as a
        // React component and rejects the hooks.
        default: function ScreenValuesProbe() {
            const store = useScreenValues();
            // Read on a CLICK, just like ActionsSection: the store is a ref and deliberately renders nothing, so a
            // probe that reads during its own render would show the state from before the publication.
            const [seen, setSeen] = useState('(not read yet)');
            return (
                <div>
                    <button type="button" onClick={() => setSeen(JSON.stringify(store ? store.readForm('claim') : 'no-store'))}>
                        read screen values
                    </button>
                    <div data-testid="screen-values-probe">{seen}</div>
                </div>
            );
        },
    };
});

import AppEditorShell from './AppEditorShell';

const FORM_APP = {
    schemaVersion: 2,
    meta: { name: 'Claims', description: '', icon: 'LayoutGrid' },
    theme: { primary: '#0F766E', radius: 'md', density: 'comfortable', fontScale: 'md', appearance: 'auto' },
    homeScreenId: 'scr_c',
    screens: [{
        id: 'scr_c', name: 'Claim', icon: null, showInNav: true, maxWidth: 'medium',
        sections: [{
            id: 'sec_c',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [{
                id: 'cmp_form01', type: 'form', visible: true,
                props: { name: 'claim', submitLabel: 'Submit', showReset: false, showSubmit: false },
                style: { span: 12, gap: 3 },
                children: [{
                    id: 'cmp_ttl001', type: 'input_text', visible: true,
                    props: { name: 'title', label: 'Title', required: false, defaultValue: 'seed' },
                    style: { span: 6 },
                }],
            }],
        }],
    }],
    actions: {},
};

const app = { id: 'app-1', name: 'Claims', definition: FORM_APP, version: 1, isPublished: false };

describe('de bewerk-canvas voedt de store die de testknop leest', () => {
    const readValues = () => {
        fireEvent.click(screen.getByRole('button', { name: 'read screen values' }));
        return screen.getByTestId('screen-values-probe').textContent;
    };

    it('publiceert de standaardwaarde zodra het formulier op de canvas staat', () => {
        render(<AppEditorShell app={app} onClose={vi.fn()} />);
        // Neither `{}` nor `null`: the canvas is in edit mode and the form has announced itself with its seed.
        expect(readValues()).toBe('{"title":"seed"}');
    });

    it('…en wat er daarna getypt wordt, ook in bewerk-modus', () => {
        render(<AppEditorShell app={app} onClose={vi.fn()} />);
        fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Typed on the canvas' } });
        expect(readValues()).toBe('{"title":"Typed on the canvas"}');
    });

    it('een formulier dat NIET op de canvas staat blijft null — geen verzonnen lege waarden', () => {
        // The counter-proof that keeps the two outcomes apart: `null` means "not on the screen" and `{}` means
        // "it is there and empty". Without this, the test above would also pass if readForm always returned
        // something.
        const other = { ...app, definition: { ...FORM_APP, screens: [{ ...FORM_APP.screens[0], sections: [{ ...FORM_APP.screens[0].sections[0], children: [] }] }] } };
        render(<AppEditorShell app={other} onClose={vi.fn()} />);
        expect(readValues()).toBe('null');
    });
});
