import { DndContext } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The pill asks for the automation's own name; the shared cache behind it is
// the only network this file touches, and it is stubbed per test.
const listAutomations = vi.fn();
vi.mock('../../../../../hooks/useAutomationApi', () => ({
    default: () => ({ listAutomations }),
}));

import EditorNodeWrapper from './EditorNodeWrapper';
import { clearAutomationTitles } from './automationTitles';
import { RuntimeProvider } from '../runtime/RuntimeContext';
import { AppEditorProvider } from '../state/AppEditorContext';

/**
 * Studio artboard 1b draws ONE worded pill beside the selected component —
 * "⚙ start automation · Offerte berekenen" — where the canvas used to draw a
 * strip of anonymous icons. The strip stays (it counts everything a component
 * carries); the pill answers the question people actually ask of a button.
 */

function makeDef(node, actions) {
    return {
        schemaVersion: 1,
        homeScreenId: 'scr_1',
        screens: [{
            id: 'scr_1', name: 'S', sections: [{ id: 'sec_1', children: [node] }],
        }],
        actions,
    };
}

function renderNode(node, actions, { selectedNodeId = node.id } = {}) {
    return render(
        <AppEditorProvider app={{ id: 'app-1', definition: makeDef(node, actions), version: 1 }}>
            <RuntimeProvider value={{ mode: 'edit', selectedNodeId, onSelectNode: vi.fn() }}>
                <DndContext>
                    <SortableContext items={[node.id]}>
                        <EditorNodeWrapper node={node} className="" style={{}} onCommit={vi.fn()}>
                            <div>child</div>
                        </EditorNodeWrapper>
                    </SortableContext>
                </DndContext>
            </RuntimeProvider>
        </AppEditorProvider>,
    );
}

const BUTTON = { id: 'cmp_btn1', type: 'button', visible: true, props: { label: 'Go' }, style: {} };

beforeEach(() => {
    clearAutomationTitles();
    listAutomations.mockReset();
    listAutomations.mockResolvedValue({ automations: [{ id: 'auto_1', title: 'Calculate quote' }] });
});

describe('the canvas logic pill', () => {
    it('names the automation a selected button starts', async () => {
        renderNode(
            { ...BUTTON, onClick: 'act_1' },
            { act_1: { kind: 'run_automation', automationId: 'auto_1' } },
        );
        await waitFor(() => {
            expect(screen.getByText('start automation · Calculate quote')).toBeInTheDocument();
        });
        expect(screen.getByText('start automation · Calculate quote'))
            .toHaveAttribute('data-logic-pill', 'run_automation');
    });

    it('still says what happens when the title cannot be fetched', async () => {
        listAutomations.mockRejectedValue(new Error('offline'));
        renderNode(
            { ...BUTTON, onClick: 'act_1' },
            { act_1: { kind: 'run_automation', automationId: 'auto_1' } },
        );
        await waitFor(() => {
            expect(screen.getByText('start automation')).toBeInTheDocument();
        });
    });

    it('asks for no titles at all when nothing runs an automation', () => {
        renderNode(
            { ...BUTTON, onClick: 'act_1' },
            { act_1: { kind: 'navigate', screenId: 'scr_1' } },
        );
        expect(listAutomations).not.toHaveBeenCalled();
        // A non-automation action still gets its pill, in the app's own colour.
        expect(screen.getByText('When clicked: Go to S'))
            .toHaveAttribute('data-logic-pill', 'navigate');
    });

    it('draws no pill on an unselected component, or on one with no action', () => {
        const { unmount } = renderNode(
            { ...BUTTON, onClick: 'act_1' },
            { act_1: { kind: 'navigate', screenId: 'scr_1' } },
            { selectedNodeId: 'someone-else' },
        );
        expect(document.querySelector('[data-logic-pill]')).toBeNull();
        unmount();

        renderNode({ ...BUTTON, visibleWhen: { kind: 'formula', expr: 'a' } }, {});
        expect(document.querySelector('[data-logic-pill]')).toBeNull();
    });

    it('kicks the floating toolbar off with the component type', () => {
        renderNode(BUTTON, {});
        expect(screen.getByText('Button')).toHaveAttribute('data-node-kicker', 'button');
    });
});
