import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { createRequire } from 'node:module';
import { useEffect } from 'react';
import { describe, it, expect, vi } from 'vitest';
import InspectorPanel from './InspectorPanel';
import { getComponentEntry } from '../runtime/componentRegistry';
import { AppEditorProvider, useAppEditor } from '../state/AppEditorContext';
import { nodeLabel } from './nodeLabel';
import { findNode, collectIds } from '../state/definitionOps';
import { KITCHEN_SINK } from '../state/sampleDefinitions';

// ActionsSection / AutomationPicker resolve automation titles through the house
// automations API — stub the network away.
vi.mock('../../../../../hooks/useAutomationApi', () => ({
    default: () => ({ listAutomations: vi.fn(async () => ({ automations: [] })) }),
    safeText: vi.fn(async () => ''),
}));

// The catalog-driven SpecPanel (the fallback Content panel — divider reaches
// it since `orientation`) reads the catalog through react-query, so the panel
// tree needs a provider; seed the real server catalog instead of a network.
const nodeRequire = createRequire(import.meta.url);
const { buildCatalog } = nodeRequire('../../../../../../../server/appStudio/componentSpecs.js');
const CATALOG = JSON.parse(JSON.stringify(buildCatalog()));

/** Drives the editor store the way the shell would (select + stream lock). */
function Driver({ nodeId = null, lock = false }) {
    const { dispatch } = useAppEditor();
    useEffect(() => {
        dispatch({ type: 'select_node', nodeId });
        dispatch({ type: 'set_stream_lock', streamLock: lock });
    }, [dispatch, nodeId, lock]);
    return null;
}

async function renderPanel({ nodeId = null, lock = false } = {}) {
    const onCommit = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['studio-apps', 'catalog'], CATALOG);
    const utils = render(
        <QueryClientProvider client={client}>
            <AppEditorProvider app={{ definition: KITCHEN_SINK, version: 1 }}>
                <Driver nodeId={nodeId} lock={lock} />
                <InspectorPanel onCommit={onCommit} />
            </AppEditorProvider>
        </QueryClientProvider>,
    );
    // Let ActionsSection's (mocked) listAutomations promise settle.
    await act(async () => {});
    return { onCommit, ...utils };
}

/**
 * The redesign (P2) split the panel into two tabs — Look (Content + Style) and
 * Behaviour (Actions + Logic) — and moved the action-kind select under an "All
 * options" disclosure. Everything these tests pin still exists; reaching some
 * of it is now one click deeper, so the click is part of the test.
 */
function showBehaviour() {
    fireEvent.click(screen.getByRole('radio', { name: 'Behaviour' }));
}
function openDisclosures() {
    for (const button of screen.queryAllByRole('button', { expanded: false })) {
        if (/all options/i.test(button.textContent || '')) fireEvent.click(button);
    }
}

describe('InspectorPanel — selection modes', () => {
    it('shows the ThemePanel when nothing is selected', async () => {
        await renderPanel();
        expect(screen.getByTestId('theme-panel')).toBeInTheDocument();
        expect(screen.getByText('App theme')).toBeInTheDocument();
        expect(screen.getByRole('radiogroup', { name: 'Theme primary color' })).toBeInTheDocument();
    });

    it('selecting a button renders ButtonInspector + Style + Actions', async () => {
        await renderPanel({ nodeId: 'cmp_refre1' });
        // Header: the component's OWN NAME is the heading, the type is the
        // eyebrow above it. Showing "Button" as the heading told the author the
        // one thing they already knew — they had just clicked the button — and
        // never which of four buttons was selected.
        const heading = screen.getByRole('heading', { name: 'Refresh' });
        // The eyebrow sits directly above the heading. Scoped to that block on
        // purpose — "Button" also appears in the Style knobs ("Button variant"),
        // and a document-wide text match would pass on the wrong element.
        expect(heading.parentElement.textContent).toContain('Button');
        expect(screen.getByRole('button', { name: 'Duplicate' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
        // Look tab: Content (per-type panel from the registry) + Style with the
        // button's knobs (span slider present).
        expect(screen.getByDisplayValue('Refresh')).toBeInTheDocument();
        expect(screen.getByText('Style')).toBeInTheDocument();
        expect(document.querySelector('input[type="range"]')).toBeTruthy();
        // Behaviour tab: Actions — the button's onClick is wired to act_fetch1
        // — and Logic.
        showBehaviour();
        expect(screen.getByText('Actions')).toBeInTheDocument();
        expect(screen.getByRole('combobox', { name: 'Action for onClick' })).toHaveValue('act_fetch1');
        expect(screen.getByText('Logic')).toBeInTheDocument();
        // …and the two halves are genuinely separate: Style is not in Behaviour.
        expect(screen.queryByText('Content')).toBeNull();
    });

    it('selecting a section (sec_*) shows the section style knobs', async () => {
        await renderPanel({ nodeId: 'sec_dash01' });
        expect(screen.getByRole('heading', { name: 'Section' })).toBeInTheDocument();
        // padding + gap sliders; background enum (a select since the look
        // pass); no Content/Actions sections.
        expect(document.querySelectorAll('input[type="range"]')).toHaveLength(2);
        expect(screen.getByRole('combobox', { name: 'Background' })).toBeInTheDocument();
        expect(screen.queryByText('Actions')).toBeNull();
    });

    it('non-event types get no Actions section, and say why', async () => {
        await renderPanel({ nodeId: 'cmp_headg1' });
        showBehaviour();
        expect(screen.queryByText('Actions')).toBeNull();
        // An empty Behaviour tab reads as a loading failure. A type with no
        // events has none to have, and the panel says so.
        expect(screen.getByText(/nothing to react to/i)).toBeInTheDocument();
    });
});

describe('InspectorPanel — panel registry coverage', () => {
    // One fixture node per component type (KITCHEN_SINK exercises all 19).
    const NODES = {
        heading: 'cmp_headg1', text: 'cmp_intro1', button: 'cmp_refre1',
        image: 'cmp_image1', divider: 'cmp_divid1', spacer: 'cmp_space1',
        callout: 'cmp_callo1', stat: 'cmp_stat01', keyValue: 'cmp_keyva1',
        table: 'cmp_table1', list: 'cmp_list01', card: 'cmp_card01',
        form: 'cmp_form01', input_text: 'cmp_insub1', input_textarea: 'cmp_indet1',
        input_number: 'cmp_inqty1', input_select: 'cmp_inpri1',
        input_checkbox: 'cmp_intfy1', input_date: 'cmp_indue1',
    };

    it('mounts an inspector for every one of the 19 types', async () => {
        for (const [type, nodeId] of Object.entries(NODES)) {
            const { unmount } = await renderPanel({ nodeId });
            const label = getComponentEntry(type).label;
            // The TYPE moved from the heading to the eyebrow, and the heading
            // now carries the component's own text. Both must be there: an
            // eyebrow alone would leave a nameless component headed by nothing,
            // and a heading alone would lose which kind of thing it is.
            const heading = screen.getByRole(
                'heading',
                { name: nodeLabel(findNode(KITCHEN_SINK, nodeId).node) },
            );
            expect(heading, `type '${type}' did not render its inspector header`).toBeInTheDocument();
            expect(
                heading.parentElement.textContent,
                `type '${type}' did not render its type eyebrow`,
            ).toContain(label);
            // Every type has Style AND Content — divider joined Content when
            // it gained `orientation` (rendered by the SpecPanel fallback).
            expect(screen.getByText('Style')).toBeInTheDocument();
            expect(screen.getByText('Content')).toBeInTheDocument();
            unmount();
        }
    });
});

describe('InspectorPanel — Studio scope in the Content panel', () => {
    // A content panel's formula fields resolve variables (and live-evaluate)
    // only inside a StudioScopeProvider; without one the picker is empty and
    // every preview reads "—".
    const STAT_APP = {
        schemaVersion: 2,
        meta: { name: 'Scope', description: '', icon: 'LayoutGrid' },
        theme: { primary: '#0F766E', radius: 'md', density: 'comfortable', fontScale: 'md', appearance: 'auto' },
        homeScreenId: 'scr_scope1',
        screens: [{
            id: 'scr_scope1', name: 'S', icon: null, showInNav: true, maxWidth: 'medium',
            sections: [{
                id: 'sec_scope1', style: {},
                children: [{
                    id: 'cmp_scope1', type: 'stat', visible: true,
                    props: { label: 'Who', value: { kind: 'formula', expr: 'currentUser.name' }, caption: null, icon: null },
                    style: { span: 3 },
                }],
            }],
        }],
        actions: {},
    };

    it('live-evaluates a content-panel formula against the Studio sample scope', async () => {
        render(
            <AppEditorProvider app={{ definition: STAT_APP, version: 1 }}>
                <Driver nodeId="cmp_scope1" />
                <InspectorPanel onCommit={vi.fn()} />
            </AppEditorProvider>,
        );
        await act(async () => {});
        expect(screen.getByDisplayValue('currentUser.name')).toBeInTheDocument();
        expect(screen.getByText('Alex Rivera')).toBeInTheDocument();
    });
});

describe('InspectorPanel — streamLock', () => {
    it('disables all inputs while the AI builder streams', async () => {
        await renderPanel({ nodeId: 'cmp_refre1', lock: true });
        expect(screen.getByDisplayValue('Refresh')).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Duplicate' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
        expect(screen.getByRole('combobox', { name: 'Button variant' })).toBeDisabled();
        // The lock has to reach the Behaviour tab too — a panel that disables
        // only what happens to be on screen is a lock with a hole in it.
        showBehaviour();
        expect(screen.getByRole('combobox', { name: 'Action for onClick' })).toBeDisabled();
        openDisclosures();
        expect(screen.getByRole('combobox', { name: 'Action kind' })).toBeDisabled();
    });
});

describe('InspectorPanel — header ops', () => {
    it('Duplicate commits a definition with a fresh copy of the node', async () => {
        const { onCommit } = await renderPanel({ nodeId: 'cmp_refre1' });
        fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
        expect(onCommit).toHaveBeenCalledTimes(1);
        const next = onCommit.mock.calls[0][0];
        expect(collectIds(next).size).toBe(collectIds(KITCHEN_SINK).size + 1);
        expect(findNode(next, 'cmp_refre1')).toBeTruthy();
    });

    it('Delete on a childless node commits removal without a confirm dialog', async () => {
        const { onCommit } = await renderPanel({ nodeId: 'cmp_refre1' });
        fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(onCommit).toHaveBeenCalledTimes(1);
        expect(findNode(onCommit.mock.calls[0][0], 'cmp_refre1')).toBeNull();
    });

    it('Delete on a container with children asks for confirmation first', async () => {
        const { onCommit } = await renderPanel({ nodeId: 'cmp_form01' });
        fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
        expect(onCommit).not.toHaveBeenCalled();
        const dialog = screen.getByRole('dialog');
        expect(dialog).toBeInTheDocument();
        // The header IconButton and the dialog confirm are both named
        // "Delete" — click the one inside the dialog explicitly.
        const confirm = Array.from(dialog.querySelectorAll('button'))
            .find((b) => b.textContent?.trim() === 'Delete');
        expect(confirm).toBeTruthy();
        fireEvent.click(confirm);
        await act(async () => {});
        expect(onCommit).toHaveBeenCalled();
        const next = onCommit.mock.calls.at(-1)[0];
        expect(findNode(next, 'cmp_form01')).toBeNull();
        expect(findNode(next, 'cmp_insub1')).toBeNull(); // children go with it
    });
});
