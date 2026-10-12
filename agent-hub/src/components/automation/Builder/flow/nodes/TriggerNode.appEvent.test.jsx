import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { ReactFlowProvider } from '@xyflow/react';
import TriggerNode from './TriggerNode';
import { NodeRuntimeContext } from '../NodeRuntimeContext';

/**
 * The trigger card is the first card anyone ever sees, and an app-event
 * trigger used to open it with the raw dotted event id in monospace
 * (`gmail.mail.new`) — machine syntax in the one slot that should be saying,
 * in words, what starts this automation.
 *
 * What this pins down is the whole doctrine, both halves:
 *   · the card shows the sentence — the name the node-config header already
 *     uses, taken from the one table that owns trigger strings;
 *   · the tooltip keeps the exact value — the id is what you search the logs
 *     for when a subscription misbehaves, so it may never be deleted;
 *   · an event nobody has written a name for yet gets a HUMANISED form of its
 *     own id, never an invented name.
 */
function renderTrigger(step) {
    return render(
        <ReactFlowProvider>
            <NodeRuntimeContext.Provider value={{
                pinnedById: new Set(), disabledById: new Set(),
                triggerIds: new Set(['trg']), primaryTriggerId: 'trg', attachedIds: new Set(),
            }}>
                <TriggerNode id="trg" data={{ step }} />
            </NodeRuntimeContext.Provider>
        </ReactFlowProvider>,
    );
}

const appEventTrigger = (appEvent) => ({
    id: 'trg', type: 'trigger', kind: 'app_event', label: 'When mail arrives',
    appEvent,
});

beforeEach(cleanup);

describe('TriggerNode — app event readability', () => {
    it('names the event instead of printing its id', () => {
        const { container } = renderTrigger(appEventTrigger({ provider: 'gmail', event: 'mail.new' }));
        expect(screen.getByText('New email (Gmail)')).toBeTruthy();
        expect(container.textContent).not.toContain('gmail.mail.new');
    });

    it('keeps the exact event id one hover away', () => {
        const { container } = renderTrigger(appEventTrigger({ provider: 'nextcloud', event: 'file.changed' }));
        expect(screen.getByText('File changed (Nextcloud)')).toBeTruthy();
        expect(container.querySelector('[title="nextcloud.file.changed"]')).toBeTruthy();
    });

    it('humanises an event nobody has named yet rather than inventing a name', () => {
        const { container } = renderTrigger(appEventTrigger({ provider: 'acme-crm', event: 'deal.won' }));
        expect(screen.getByText('Deal won (Acme crm)')).toBeTruthy();
        expect(container.textContent).not.toContain('acme-crm.deal.won');
        expect(container.querySelector('[title="acme-crm.deal.won"]')).toBeTruthy();
    });

    it('still shows the filter chips next to the event name', () => {
        renderTrigger(appEventTrigger({
            provider: 'gmail',
            event: 'mail.new',
            filter: { from: 'boss@example.com', hasAttachment: true },
        }));
        expect(screen.getByText('New email (Gmail)')).toBeTruthy();
        expect(screen.getByText('from: boss@example.com')).toBeTruthy();
        expect(screen.getByText('has attachment')).toBeTruthy();
    });
});
