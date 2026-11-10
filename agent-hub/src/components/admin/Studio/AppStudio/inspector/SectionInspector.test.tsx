import { createRequire } from 'node:module';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { describe, it, expect, vi } from 'vitest';
import InspectorPanel from './InspectorPanel';
import { AppEditorProvider, useAppEditor } from '../state/AppEditorContext';
import { findSection } from '../state/definitionOps';
import { KITCHEN_SINK } from '../state/sampleDefinitions';
import type { AppDefinition } from './appDefinition';

const nodeRequire = createRequire(import.meta.url);
const { buildCatalog } = nodeRequire('../../../../../../../server/appStudio/componentSpecs.js');
const CATALOG = JSON.parse(JSON.stringify(buildCatalog()));

function Driver({ nodeId }: { nodeId: string }) {
    const { dispatch } = useAppEditor();
    useEffect(() => { dispatch({ type: 'select_node', nodeId }); }, [dispatch, nodeId]);
    return null;
}

/** The inspector on a selected section, with every commit written back into the editor store. */
function Committing({ onCommit }: { onCommit: (def: AppDefinition) => void }) {
    const { dispatch } = useAppEditor();
    return (
        <InspectorPanel onCommit={(def) => { onCommit(def); dispatch({ type: 'set_definition', definition: def }); }} />
    );
}

async function renderSection(sectionId: string, definition: AppDefinition = KITCHEN_SINK) {
    const onCommit = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['studio-apps', 'catalog'], CATALOG);
    render(
        <QueryClientProvider client={client}>
            <AppEditorProvider app={{ definition, version: 1 }}>
                <Driver nodeId={sectionId} />
                <Committing onCommit={onCommit} />
            </AppEditorProvider>
        </QueryClientProvider>,
    );
    await act(async () => {});
    const last = (): AppDefinition => onCommit.mock.calls[onCommit.mock.calls.length - 1][0];
    return { onCommit, last };
}

const sectionIdsOf = (def: AppDefinition, screenId: string) => (def.screens || []).find((s) => s.id === screenId)!.sections!.map((s) => s.id);

describe('SectionInspector', () => {
    it('sets a title, then removes it again when the field is emptied', async () => {
        const user = userEvent.setup();
        const { last } = await renderSection('sec_dash01');
        const field = screen.getByPlaceholderText('e.g. Open orders');
        await user.type(field, 'Open');
        expect(findSection(last(), 'sec_dash01')!.section.title).toBe('Open');
        await user.clear(field);
        expect('title' in findSection(last(), 'sec_dash01')!.section).toBe(false);
    });

    it('folding needs a title; the width cap writes maxWidth and Screen removes it', async () => {
        const user = userEvent.setup();
        const { last } = await renderSection('sec_dash01');
        expect(screen.getByRole('checkbox', { name: 'Can be folded' })).toBeDisabled();
        await user.type(screen.getByPlaceholderText('e.g. Open orders'), 'H');
        await user.click(screen.getByRole('checkbox', { name: 'Can be folded' }));
        expect(findSection(last(), 'sec_dash01')!.section.collapsible).toBe(true);
        await user.click(within(screen.getByRole('radiogroup', { name: 'Width' })).getByRole('radio', { name: 'S' }));
        expect(findSection(last(), 'sec_dash01')!.section.maxWidth).toBe('narrow');
        await user.click(within(screen.getByRole('radiogroup', { name: 'Width' })).getByRole('radio', { name: 'Screen' }));
        expect('maxWidth' in findSection(last(), 'sec_dash01')!.section).toBe(false);
    });

    it('moves, duplicates and adds sections through the shared ops', async () => {
        const user = userEvent.setup();
        const { last } = await renderSection('sec_dash01');
        const before = sectionIdsOf(KITCHEN_SINK, 'scr_dash01');
        expect(screen.getByRole('button', { name: 'Move section up' })).toBeDisabled();
        await user.click(screen.getByRole('button', { name: 'Move section down' }));
        expect(sectionIdsOf(last(), 'scr_dash01')).toEqual([before[1], before[0], ...before.slice(2)]);
        await user.click(screen.getByRole('button', { name: 'Duplicate section' }));
        expect(sectionIdsOf(last(), 'scr_dash01')).toHaveLength(before.length + 1);
        await user.click(screen.getByRole('button', { name: 'Add a section below' }));
        expect(sectionIdsOf(last(), 'scr_dash01')).toHaveLength(before.length + 2);
    });

    it('asks before deleting a section that holds components', async () => {
        const user = userEvent.setup();
        const { onCommit, last } = await renderSection('sec_dash01');
        await user.click(screen.getByRole('button', { name: 'Delete section' }));
        expect(onCommit).not.toHaveBeenCalled();
        // The confirm dialog's own button carries the same label; it is the last one rendered.
        const buttons = screen.getAllByRole('button', { name: 'Delete section' });
        expect(buttons.length).toBe(2);
        await user.click(buttons[buttons.length - 1]);
        expect(findSection(last(), 'sec_dash01')).toBeNull();
    });
});
