import { DndContext } from '@dnd-kit/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { useEffect } from 'react';
import { describe, it, expect, vi } from 'vitest';
// The palette reads the component catalog for its per-card descriptions.
// Stubbed so this suite makes no network call — an unmocked one resolves after
// the test ends and logs through a closed worker channel.
vi.mock('../studioAppsApi', () => ({
    studioAppsApi: { getCatalog: vi.fn().mockResolvedValue({ components: {} }) },
}));

import ComponentRibbon, { CompactComponentBar } from './ComponentRibbon';
import { PALETTE_CATEGORIES, PALETTE_STARTERS, APP_COMPONENT_TYPES } from '../runtime/componentRegistry';
import { AppEditorProvider, useAppEditor } from '../state/AppEditorContext';
import { findNode } from '../state/definitionOps';
import { KITCHEN_SINK } from '../state/sampleDefinitions';

function Driver({ streamLock = false, screenId, selectedNodeId }) {
    const { dispatch } = useAppEditor();
    useEffect(() => {
        dispatch({ type: 'set_stream_lock', streamLock });
    }, [dispatch, streamLock]);
    useEffect(() => {
        if (selectedNodeId) dispatch({ type: 'select_node', nodeId: selectedNodeId });
        if (screenId) dispatch({ type: 'set_screen', screenId });
    }, [dispatch, screenId, selectedNodeId]);
    return null;
}

function renderRibbon({ streamLock = false, screenId, selectedNodeId } = {}) {
    const onCommit = vi.fn();
    // The palette reads the session-cached component catalog for the per-card
    // description (the same query the inspector already runs), so it needs the
    // QueryClient the editor always has around it in the app.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const utils = render(
        <QueryClientProvider client={client}>
            <AppEditorProvider app={{ definition: KITCHEN_SINK, version: 1 }}>
                <Driver streamLock={streamLock} screenId={screenId} selectedNodeId={selectedNodeId} />
                <DndContext>
                    <ComponentRibbon onCommit={onCommit} />
                </DndContext>
            </AppEditorProvider>
        </QueryClientProvider>,
    );
    return { onCommit, ...utils };
}

// Categories that actually carry components — an empty category (e.g. 'AI'
// before its first component ships) has no tab.
const POPULATED_CATEGORIES = PALETTE_CATEGORIES.filter(
    (c) => Object.values(APP_COMPONENT_TYPES).some((e) => e.category === c),
);

describe('ComponentRibbon — always-visible strip', () => {
    it('is a toolbar with one tab per populated component category', () => {
        renderRibbon();
        expect(screen.getByRole('toolbar', { name: 'Add a component' })).toBeInTheDocument();
        for (const category of POPULATED_CATEGORIES) {
            expect(screen.getByRole('tab', { name: category })).toBeInTheDocument();
        }
    });

    it('shows only the active category, switching on tab click', () => {
        renderRibbon();
        // Default tab is "Start here" → Button shows, Divider (Layout) hidden.
        expect(screen.getByTitle(/^Button — click to add/)).toBeInTheDocument();
        expect(screen.queryByTitle(/^Divider — click to add/)).toBeNull();

        act(() => { fireEvent.click(screen.getByRole('tab', { name: 'Layout' })); });
        expect(screen.getByTitle(/^Divider — click to add/)).toBeInTheDocument();
        expect(screen.queryByTitle(/^Button — click to add/)).toBeNull();
    });

    it('click-adds a component, committing a new definition', () => {
        const { onCommit } = renderRibbon();
        const card = screen.getByTitle(/^Button — click to add/);
        act(() => { fireEvent.click(card); });
        expect(onCommit).toHaveBeenCalledTimes(1);
        expect(onCommit.mock.calls[0][0]).not.toBe(KITCHEN_SINK);
    });

    it('search surfaces matches across categories, bypassing the active tab', () => {
        renderRibbon();
        // Searching leaves the tab filter behind and reaches every category.
        act(() => { fireEvent.change(screen.getByLabelText('Search components'), { target: { value: 'button' } }); });
        expect(screen.getByTitle(/^Button — click to add/)).toBeInTheDocument();
        // A Layout-only component is not among the 'button' matches.
        expect(screen.queryByTitle(/^Divider — click to add/)).toBeNull();
    });

    it('does not add while the AI builder streams (streamLock)', () => {
        const { onCommit } = renderRibbon({ streamLock: true });
        act(() => { fireEvent.click(screen.getByTitle(/^Button — click to add/)); });
        expect(onCommit).not.toHaveBeenCalled();
    });

    it('opens on a "Start here" tab holding the starter components', () => {
        renderRibbon();
        expect(screen.getByRole('tab', { name: 'Start here', selected: true })).toBeInTheDocument();
        for (const type of PALETTE_STARTERS) {
            const label = APP_COMPONENT_TYPES[type].label;
            expect(screen.getByTitle(new RegExp(`^${label} — click to add`))).toBeInTheDocument();
        }
        // It is a VIEW, not a re-homing: the categories still own their types.
        expect(APP_COMPONENT_TYPES.heading.category).toBe('Content');
        expect(APP_COMPONENT_TYPES.button.category).toBe('Basics');
    });

    it('keeps every category tab reachable next to the starter tab', () => {
        renderRibbon();
        act(() => { fireEvent.click(screen.getByRole('tab', { name: 'Basics' })); });
        expect(screen.getByTitle(/^Button — click to add/)).toBeInTheDocument();
        // Heading lives under Content, so the Basics tab must not show it.
        expect(screen.queryByTitle(/^Heading — click to add/)).toBeNull();
    });

    it('searching lists each match once (the starter view never doubles it up)', () => {
        renderRibbon();
        act(() => { fireEvent.change(screen.getByLabelText('Search components'), { target: { value: 'heading' } }); });
        expect(screen.getAllByTitle(/^Heading — click to add/)).toHaveLength(1);
    });

    it('adds to the screen the user is LOOKING at, not the selection\'s screen (Bug 6)', () => {
        // Anchor selected on screen 2, canvas showing screen 1.
        const { onCommit } = renderRibbon({ selectedNodeId: 'cmp_head21', screenId: 'scr_dash01' });
        act(() => { fireEvent.click(screen.getByTitle(/^Button — click to add/)); });

        expect(onCommit).toHaveBeenCalledTimes(1);
        const def = onCommit.mock.calls[0][0];
        const added = def.screens[0].sections.at(-1).children.at(-1);
        expect(added.type).toBe('button');
        // …and nothing was appended next to the off-screen selection.
        expect(findNode(def, 'cmp_head21').parent.children).toHaveLength(
            findNode(KITCHEN_SINK, 'cmp_head21').parent.children.length,
        );
    });

    it('still inserts right after the selection when it is on the visible screen', () => {
        const { onCommit } = renderRibbon({ selectedNodeId: 'cmp_headg1', screenId: 'scr_dash01' });
        act(() => { fireEvent.click(screen.getByTitle(/^Button — click to add/)); });
        const def = onCommit.mock.calls[0][0];
        const children = def.screens[0].sections[0].children;
        const anchorIdx = children.findIndex((c) => c.id === 'cmp_headg1');
        expect(children[anchorIdx + 1].type).toBe('button');
    });
});

describe('ComponentRibbon — collapse', () => {
    it('hides the strip when collapsed; picking a category tab reopens it', () => {
        renderRibbon();
        expect(screen.getByTitle(/^Button — click to add/)).toBeInTheDocument();

        act(() => { fireEvent.click(screen.getByRole('button', { name: 'Hide the component strip' })); });
        expect(screen.queryByTitle(/^Button — click to add/)).toBeNull();
        // The category tabs stay reachable while collapsed…
        expect(screen.getByRole('tab', { name: 'Layout' })).toBeInTheDocument();

        // …and picking one IS asking to see components again.
        act(() => { fireEvent.click(screen.getByRole('tab', { name: 'Layout' })); });
        expect(screen.getByTitle(/^Divider — click to add/)).toBeInTheDocument();
    });

    it('reopens a collapsed strip when a search begins', () => {
        renderRibbon();
        act(() => { fireEvent.click(screen.getByRole('button', { name: 'Hide the component strip' })); });
        expect(screen.queryByTitle(/^Button — click to add/)).toBeNull();

        act(() => { fireEvent.change(screen.getByLabelText('Search components'), { target: { value: 'button' } }); });
        expect(screen.getByTitle(/^Button — click to add/)).toBeInTheDocument();
    });

    it('can reopen from the toggle itself', () => {
        renderRibbon();
        const toggle = screen.getByRole('button', { name: 'Hide the component strip' });
        act(() => { fireEvent.click(toggle); });
        expect(screen.queryByTitle(/^Button — click to add/)).toBeNull();

        act(() => { fireEvent.click(screen.getByRole('button', { name: 'Show the component strip' })); });
        expect(screen.getByTitle(/^Button — click to add/)).toBeInTheDocument();
    });
});

describe('ComponentRibbon — findability', () => {
    it('has an "All" view, because per-category tabs hide most of the catalog', () => {
        // 'Basics' and 'AI' hold one component each while 'Data' holds sixteen,
        // so whichever tab you land on, most of the catalog sits behind a tab
        // you have no reason to click.
        renderRibbon();
        const all = screen.getByRole('tab', { name: 'All' });
        fireEvent.click(all);

        // Every populated category's cluster is on screen at once. (getAllByText:
        // each name appears twice — once as its tab, once as its cluster caption.)
        for (const category of POPULATED_CATEGORIES) {
            expect(screen.getAllByText(category).length).toBeGreaterThan(1);
        }
        // …and a component from the biggest cluster is reachable without
        // switching tabs at all.
        expect(screen.getAllByRole('button', { name: /Data grid/i }).length).toBeGreaterThan(0);
    });
});

/**
 * The COMPACT bar is row 2 of the editor (Studio artboard 1b): eight chips —
 * Button · Input field · Table view · Heading · File · Layout ▾ · Data ▾ ·
 * AI block — plus "All components", which unfolds the full ribbon above,
 * and the search field. The eight chips are the artboard's; the "All
 * components" fold is the recorded deviation (the catalog holds ~50 types,
 * which no eight chips can carry).
 */
function renderCompact({ streamLock = false } = {}) {
    const onCommit = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const utils = render(
        <QueryClientProvider client={client}>
            <AppEditorProvider app={{ definition: KITCHEN_SINK, version: 1 }}>
                <Driver streamLock={streamLock} />
                <DndContext>
                    <div className="flex flex-wrap">
                        <CompactComponentBar onCommit={onCommit} />
                    </div>
                </DndContext>
            </AppEditorProvider>
        </QueryClientProvider>,
    );
    return { onCommit, ...utils };
}

describe('CompactComponentBar — the eight chips of row 2', () => {
    it('draws the artboard\u2019s chips, in its order', () => {
        renderCompact();
        expect(screen.getByTestId('palette-kicker')).toHaveTextContent('Components');
        for (const name of ['Button', 'Input field', 'Table view', 'Heading', 'File', 'AI block']) {
            expect(screen.getByRole('button', { name: new RegExp(`^${name}$`) })).toBeInTheDocument();
        }
        // The two category chips name themselves as menus over a category.
        expect(screen.getByRole('button', { name: 'Layout components' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Data components' })).toBeInTheDocument();
    });

    it('adds a component on click, without the full ribbon ever opening', () => {
        const { onCommit } = renderCompact();
        fireEvent.click(screen.getByRole('button', { name: 'Heading' }));
        expect(onCommit).toHaveBeenCalledTimes(1);
        const def = onCommit.mock.calls[0][0];
        const added = def.screens
            .flatMap((s) => s.sections)
            .flatMap((sec) => sec.children)
            .filter((c) => c.type === 'heading');
        expect(added.length).toBeGreaterThan(0);
        expect(document.getElementById('app-studio-full-ribbon')).toBeNull();
    });

    it('"Layout" and "Data" are menus over their whole category, not single chips', () => {
        renderCompact();
        act(() => { fireEvent.click(screen.getByRole('button', { name: 'Layout components' })); });
        // Every Layout component is offered, not just one.
        const layoutTypes = Object.entries(APP_COMPONENT_TYPES).filter(([, e]) => e.category === 'Layout');
        expect(layoutTypes.length).toBeGreaterThan(1);
        expect(screen.getAllByRole('menuitem').length).toBe(layoutTypes.length);
    });

    it('"All components" unfolds the full ribbon under the row, and folds it back', () => {
        renderCompact();
        const toggle = screen.getByRole('button', { name: /All components/ });
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
        act(() => { fireEvent.click(toggle); });
        expect(document.getElementById('app-studio-full-ribbon')).toBeInTheDocument();
        expect(screen.getByRole('toolbar', { name: 'Add a component' })).toBeInTheDocument();
        act(() => { fireEvent.click(toggle); });
        expect(document.getElementById('app-studio-full-ribbon')).toBeNull();
    });

    it('searching unfolds it too — the query searches the WHOLE catalog', () => {
        renderCompact();
        act(() => {
            fireEvent.change(screen.getByRole('textbox', { name: 'Search components' }), { target: { value: 'grid' } });
        });
        expect(document.getElementById('app-studio-full-ribbon')).toBeInTheDocument();
        expect(screen.getAllByRole('button', { name: /Data grid/i }).length).toBeGreaterThan(0);
    });

    it('every chip is dead while the AI holds the stream lock', () => {
        renderCompact({ streamLock: true });
        expect(screen.getByRole('button', { name: 'Heading' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Layout components' })).toBeDisabled();
    });
});
