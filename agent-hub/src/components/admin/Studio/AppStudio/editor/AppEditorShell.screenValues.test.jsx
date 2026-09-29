import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render as rtlRender, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * DE DRAAD TUSSEN HET SCHERM EN DE TESTKNOP — end-to-end, in de modus waarin
 * die knop echt bestaat.
 *
 * De store (ScreenValuesContext) en de payloadbouwer (inspector/testPayload)
 * zijn allebei los grondig getest, en de LOCKSTEP-test ernaast bewijst dat
 * AppForm publiceert onder de sleutel die de inspector leest. Wat NIEMAND
 * bewees, was de draad ertussen:
 *
 *   1. `Canvas` geeft `registerFormValue` door aan zijn AppRenderer — en deed
 *      dat alleen in de PREVIEW-tak. De inspector, en dus "Test with what is
 *      on screen", bestaat juist alleen in BEWERK-modus
 *      (`mode === 'edit' && editorView === 'edit'`), dus de store kreeg in
 *      precies die modus nooit iets binnen: elke {kind:'field'}-parameter viel
 *      weg met de reden "dat formulier staat niet op de canvas" — over een
 *      formulier dat er zichtbaar wél stond.
 *   2. `screenValues?.publish(...)` in diezelfde callback. Die regel weghalen
 *      liet 780 tests in editor/ en inspector/ groen.
 *
 * Vandaar deze test: de ECHTE shell, de ECHTE canvas in bewerk-modus, de ECHTE
 * store. De inspector is vervangen door een sonde die de store uitleest zoals
 * ActionsSection dat doet — dat is het enige stuk dat hier gemockt wordt, want
 * de vraag is niet wat de inspector tekent maar wat hij te lezen krijgt.
 */

const render = (ui, options) => rtlRender(
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
    // Async-factory: `vi.mock` wordt boven de imports gehesen, dus de echte
    // context wordt hier binnengehaald in plaats van uit een bovenliggende
    // binding gelezen.
    const { useScreenValues } = await import('./ScreenValuesContext');
    const { useState } = await import('react');
    return {
        // Een benoemde component: de hooks-regel van eslint herkent een
        // anonieme pijlfunctie niet als React-component en wijst de hooks af.
        default: function ScreenValuesProbe() {
            const store = useScreenValues();
            // Lezen op een KLIK, precies zoals ActionsSection: de store is een
            // ref en rendert bewust niets opnieuw, dus een probe die bij zijn
            // eigen render leest zou de stand van vóór de publicatie tonen.
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
        // Niet `{}` en niet `null`: de canvas staat in bewerk-modus en het
        // formulier heeft zich met zijn seed gemeld.
        expect(readValues()).toBe('{"title":"seed"}');
    });

    it('…en wat er daarna getypt wordt, ook in bewerk-modus', () => {
        render(<AppEditorShell app={app} onClose={vi.fn()} />);
        fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Typed on the canvas' } });
        expect(readValues()).toBe('{"title":"Typed on the canvas"}');
    });

    it('een formulier dat NIET op de canvas staat blijft null — geen verzonnen lege waarden', () => {
        // De tegenproef die de twee uitslagen uit elkaar houdt: `null` betekent
        // "staat niet op het scherm" en `{}` betekent "staat er en is leeg".
        // Zonder deze zou de test hierboven ook slagen als readForm altijd iets
        // teruggaf.
        const other = { ...app, definition: { ...FORM_APP, screens: [{ ...FORM_APP.screens[0], sections: [{ ...FORM_APP.screens[0].sections[0], children: [] }] }] } };
        render(<AppEditorShell app={other} onClose={vi.fn()} />);
        expect(readValues()).toBe('null');
    });
});
