import { createRequire } from 'node:module';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { useEffect } from 'react';
import { describe, it, expect, vi } from 'vitest';

/**
 * A TRANSLATED inspector shell.
 *
 * InspectorPanel.test.jsx finds every part of this panel by its English name —
 * the "Style" band, the "Delete" icon button, the `Action kind` select — and
 * that is exactly what it should assert: those are the strings a user with no
 * translation still sees. Which is also why that suite cannot see the failure
 * this file exists for. A hard-coded English accordion title and a translated
 * one render identically in English, so the whole panel could stay untouched
 * by a Dutch locale while every sibling assertion kept passing.
 *
 * The panel is worth its own suite because most of its chrome is a NAME rather
 * than a sentence: four accordion bands, two icon buttons whose only label is
 * an aria-label, and the confirm dialog that decides whether a container full
 * of components is deleted. A Dutch author who cannot read "Delete" on that
 * dialog is one click from losing a form.
 */
// vi.mock's factory is hoisted above every import, so the stub is built inside
// it — a module-scope helper would not exist yet when the first component in
// the tree imports the hook.
vi.mock('../../../../../hooks/useTranslation', () => {
    const NL = {
        'app_studio.inspector.actions': 'Acties',
        'app_studio.inspector.content': 'Inhoud',
        'app_studio.inspector.delete_desc': 'Er staan andere onderdelen in — alles wat erin zit wordt ook verwijderd.',
        'app_studio.inspector.kind_aria': 'Soort actie',
        'app_studio.inspector.logic': 'Logica',
        'app_studio.inspector.section': 'Sectie',
        'app_studio.inspector.style': 'Vormgeving',
        // The two header buttons and the confirm dialog share the canvas node
        // chrome's keys — one "Delete" for the whole editor, not two.
        'app_studio.canvas.delete': 'Verwijderen',
        'app_studio.canvas.delete_one_title': 'Deze {label} verwijderen?',
        'app_studio.canvas.duplicate': 'Dupliceren',
        // app_studio.inspector.component is deliberately NOT translated —
        // see the last case.
    };
    const t = (key, fallbackOrParams, paramsArg) => {
        const hasFallback = typeof fallbackOrParams === 'string';
        const params = hasFallback ? paramsArg : fallbackOrParams;
        let value = NL[key] ?? (hasFallback ? fallbackOrParams : key);
        if (params && typeof params === 'object') {
            for (const [k, v] of Object.entries(params)) {
                value = value.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
            }
        }
        return value;
    };
    const useTranslation = () => ({ t, locale: 'nl', setLocale: () => { }, isLoading: false, strings: NL });
    return {
        default: useTranslation,
        useTranslation,
        TranslationProvider: ({ children }) => children,
        ensureI18nDefaults: () => Promise.resolve(),
    };
});

// ActionsSection / RoutinePicker resolve routine titles through the house
// automations API — stub the network away, exactly as the sibling suite does.
vi.mock('../../../../../hooks/useAutomationApi', () => ({
    default: () => ({ listAutomations: vi.fn(async () => ({ automations: [] })) }),
    safeText: vi.fn(async () => ''),
}));

import InspectorPanel from './InspectorPanel';
import { AppEditorProvider, useAppEditor } from '../state/AppEditorContext';
import { KITCHEN_SINK } from '../state/sampleDefinitions';

// The catalog-driven Content panel reads the component catalog through
// react-query; seed the real server catalog instead of a network.
const nodeRequire = createRequire(import.meta.url);
const { buildCatalog } = nodeRequire('../../../../../../../server/appStudio/componentSpecs.js');
const CATALOG = JSON.parse(JSON.stringify(buildCatalog()));

function Driver({ nodeId }) {
    const { dispatch } = useAppEditor();
    useEffect(() => {
        dispatch({ type: 'select_node', nodeId });
    }, [dispatch, nodeId]);
    return null;
}

async function renderPanel(nodeId) {
    const onCommit = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['studio-apps', 'catalog'], CATALOG);
    const utils = render(
        <QueryClientProvider client={client}>
            <AppEditorProvider app={{ definition: KITCHEN_SINK, version: 1 }}>
                <Driver nodeId={nodeId} />
                <InspectorPanel onCommit={onCommit} />
            </AppEditorProvider>
        </QueryClientProvider>,
    );
    await act(async () => { });
    return { onCommit, ...utils };
}

/** "Behaviour" is not in the stub, so the tab keeps its English name here. */
function showBehaviour() {
    fireEvent.click(screen.getByRole('radio', { name: 'Behaviour' }));
}

describe('InspectorPanel — the translated inspector chrome', () => {
    it('names the Look accordions in the active language', async () => {
        await renderPanel('cmp_refre1');

        expect(screen.getByText('Inhoud')).toBeInTheDocument();
        expect(screen.getByText('Vormgeving')).toBeInTheDocument();
        // The bands are the ONLY thing naming what is inside them, so a
        // half-translated panel would say "Content" over Dutch fields.
        expect(screen.queryByText('Content')).toBeNull();
        expect(screen.queryByText('Style')).toBeNull();
    });

    it('names the Behaviour accordions in the active language', async () => {
        await renderPanel('cmp_refre1');
        showBehaviour();

        expect(screen.getByText('Acties')).toBeInTheDocument();
        expect(screen.getByText('Logica')).toBeInTheDocument();
        expect(screen.queryByText('Actions')).toBeNull();
    });

    it('translates the section heading and its one band', async () => {
        await renderPanel('sec_dash01');

        expect(screen.getByRole('heading', { name: 'Sectie' })).toBeInTheDocument();
        expect(screen.getByText('Vormgeving')).toBeInTheDocument();
    });

    it('names the two header icon buttons — their only label is the aria one', async () => {
        await renderPanel('cmp_refre1');

        expect(screen.getByRole('button', { name: 'Dupliceren' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Verwijderen' })).toBeInTheDocument();
    });

});

describe('InspectorPanel — the translated destructive path', () => {
    it('translates the whole delete confirmation, button included', async () => {
        const { onCommit } = await renderPanel('cmp_form01');
        fireEvent.click(screen.getByRole('button', { name: 'Verwijderen' }));

        const dialog = screen.getByRole('dialog');
        // The component TYPE inside the question comes from the component
        // registry, which is not translated (see the P5 list of surfaces that
        // stay English) — the sentence around it is.
        expect(dialog.textContent).toContain('Deze form verwijderen?');
        expect(dialog.textContent).toContain('Er staan andere onderdelen in');

        // The confirm button carries the same key as the header button, so a
        // translation that reached one has to have reached the other.
        const confirm = Array.from(dialog.querySelectorAll('button'))
            .find((b) => b.textContent?.trim() === 'Verwijderen');
        expect(confirm).toBeTruthy();
        fireEvent.click(confirm);
        await act(async () => { });
        expect(onCommit).toHaveBeenCalled();
    });

    it('labels the action-kind select, which has no visible name at all', async () => {
        await renderPanel('cmp_refre1');
        showBehaviour();
        for (const button of screen.queryAllByRole('button', { expanded: false })) {
            if (/all options/i.test(button.textContent || '')) fireEvent.click(button);
        }

        expect(screen.getByRole('combobox', { name: 'Soort actie' })).toBeInTheDocument();
    });

    it('falls back to the call site English for a key the catalogue does not have', async () => {
        // `component` is the stand-in the delete question uses when the registry
        // has no entry for the node's type. It is not in the stub above, so an
        // untranslated key must show its English fallback, never the raw key.
        const definition = {
            ...KITCHEN_SINK,
            homeScreenId: 'scr_x',
            screens: [{
                id: 'scr_x',
                name: 'X',
                showInNav: true,
                maxWidth: 'medium',
                sections: [{
                    id: 'sec_x',
                    style: { padding: 4, gap: 3, background: 'none' },
                    children: [{
                        id: 'cmp_x',
                        type: 'not_a_real_type',
                        visible: true,
                        props: {},
                        style: { span: 12 },
                        children: [{ id: 'cmp_y', type: 'text', visible: true, props: { text: 'inside' }, style: { span: 12 } }],
                    }],
                }],
            }],
        };
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        client.setQueryData(['studio-apps', 'catalog'], CATALOG);
        render(
            <QueryClientProvider client={client}>
                <AppEditorProvider app={{ definition, version: 1 }}>
                    <Driver nodeId="cmp_x" />
                    <InspectorPanel onCommit={vi.fn()} />
                </AppEditorProvider>
            </QueryClientProvider>,
        );
        await act(async () => { });
        fireEvent.click(screen.getByRole('button', { name: 'Verwijderen' }));

        const dialog = screen.getByRole('dialog');
        expect(dialog.textContent).toContain('Deze component verwijderen?');
        expect(dialog.textContent).not.toContain('app_studio.inspector.component');
    });
});
