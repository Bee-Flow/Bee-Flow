import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../utils/helpers', async (importOriginal) => ({
    ...(await importOriginal()),
    authFetch: (...args) => authFetch(...args),
}));

import TriggerNode from './TriggerNode';
import { __clearAppRefCacheForTests } from '../appRefLabel';
import { NodeRuntimeContext } from '../NodeRuntimeContext';

/**
 * The app-trigger card has to say WHERE the button is — and has to keep saying
 * something true when it cannot.
 *
 * Three failures this pins down, all of which look identical on a card that
 * only renders the happy path:
 *   · a name shown for an app the viewer was never allowed to read;
 *   · a back-pointer that resolves to nothing rendering as an ordinary,
 *     nameless trigger, as if the automation simply had no origin;
 *   · the signed-in user disappearing from the card because no input happens
 *     to be declared — it travels on every run either way.
 */

const authFetch = vi.fn();
const ok = (body) => ({ ok: true, status: 200, json: async () => body });

const REF = { appId: '5f2a1c34-8b7d-4e19-9f00-2ab3c4d5e6f7', screenId: 'scr_dash01', nodeId: 'cmp_btn123' };

function appTrigger(overrides = {}) {
    return {
        id: 'trg', type: 'trigger', kind: 'app_trigger', label: 'Start',
        params: [{ name: 'amount', type: 'number', required: true }],
        appRef: REF,
        ...overrides,
    };
}

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

/** Answer the one /ref lookup this card makes. */
function answer(record) {
    authFetch.mockResolvedValue(ok(record));
}

beforeEach(() => {
    cleanup();
    authFetch.mockReset();
    __clearAppRefCacheForTests();
});
afterEach(cleanup);

describe('the kicker names what starts the automation', () => {
    it('reads "Button in an app" instead of the generic trigger word', async () => {
        answer({ status: 'ok', ...REF, appName: 'Expenses', screenName: 'Dashboard', nodeLabel: 'Submit', canOpen: true });
        renderTrigger(appTrigger());
        expect(await screen.findByText('Button in an app')).toBeTruthy();
    });
});

describe('where the button is', () => {
    it('names the app and the screen once the server says the viewer may be told', async () => {
        answer({ status: 'ok', ...REF, appName: 'Expenses', screenName: 'Dashboard', nodeLabel: 'Submit', canOpen: true });
        const { container } = renderTrigger(appTrigger());
        await waitFor(() => expect(container.textContent).toContain('Expenses'));
        expect(container.textContent).toContain('Dashboard');
        // The ids stay one hover away, and never on screen instead of a name.
        expect(container.querySelector(`[title="${REF.appId} · ${REF.screenId}"]`)).toBeTruthy();
        expect(container.textContent).not.toContain(REF.appId);
    });

    it('shows NO name for an app the viewer may not open', async () => {
        // A name the viewer was not allowed to read is a leak, and a link that
        // lands on a refusal is worse than no link.
        answer({ status: 'restricted', ...REF, appName: null, screenName: null, nodeLabel: null, canOpen: false });
        const { container } = renderTrigger(appTrigger());
        await waitFor(() => expect(container.textContent).toContain('An app you cannot open'));
        expect(container.textContent).not.toContain('Expenses');
        expect(container.querySelectorAll('a').length).toBe(0);
    });

    it('says the app is GONE rather than falling back to a nameless trigger', async () => {
        answer({ status: 'app_missing', ...REF, appName: null, screenName: null, nodeLabel: null, canOpen: false });
        const { container } = renderTrigger(appTrigger());
        await waitFor(() => expect(container.textContent).toContain('App is gone'));
    });

    it('says the SCREEN is gone while still naming the app', async () => {
        answer({ status: 'screen_missing', ...REF, appName: 'Expenses', screenName: null, nodeLabel: null, canOpen: true });
        const { container } = renderTrigger(appTrigger());
        await waitFor(() => expect(container.textContent).toContain('screen is gone'));
        expect(container.textContent).toContain('Expenses');
    });

    it('claims nothing at all when the lookup could not be made', async () => {
        authFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
        const { container } = renderTrigger(appTrigger());
        // The id is true even when nothing else is; "gone" would not be.
        await waitFor(() => expect(container.textContent).toContain(REF.appId));
        expect(container.textContent).not.toContain('gone');
    });

    it('asks nothing, and says nothing, for a trigger with no back-pointer', async () => {
        renderTrigger(appTrigger({ appRef: undefined }));
        expect(await screen.findByText('amount*')).toBeTruthy();
        expect(authFetch).not.toHaveBeenCalled();
    });

    it('treats a HALF-written back-pointer as no back-pointer', async () => {
        // Same rule the server applies at save time. A hand-edited definition
        // must not make the card render "undefined · undefined".
        renderTrigger(appTrigger({ appRef: { appId: REF.appId } }));
        expect(await screen.findByText('amount*')).toBeTruthy();
        expect(authFetch).not.toHaveBeenCalled();
    });
});

describe('the inputs row', () => {
    it('always carries the signed-in user, declared inputs or not', async () => {
        answer({ status: 'ok', ...REF, appName: 'Expenses', screenName: 'Dashboard', canOpen: true });
        renderTrigger(appTrigger({ params: [] }));
        // Every app_trigger run carries `_viewerUserId`; a card that said "no
        // inputs" would be wrong about the one value that is always sent.
        expect(await screen.findByText('Signed-in user')).toBeTruthy();
        expect(screen.queryByText('no inputs')).toBeNull();
    });

    it('says WHAT of the viewer travels, on hover', async () => {
        answer({ status: 'ok', ...REF, appName: 'Expenses', screenName: 'Dashboard', canOpen: true });
        const { container } = renderTrigger(appTrigger({ params: [] }));
        await screen.findByText('Signed-in user');
        expect(container.querySelector('[title="Their ID only — no name or e-mail address"]')).toBeTruthy();
    });

    it('still lists the declared inputs beside it', async () => {
        answer({ status: 'ok', ...REF, appName: 'Expenses', screenName: 'Dashboard', canOpen: true });
        renderTrigger(appTrigger({ params: [{ name: 'amount', required: true }, { name: 'note' }] }));
        expect(await screen.findByText('amount*')).toBeTruthy();
        expect(screen.getByText('note')).toBeTruthy();
        expect(screen.getByText('Signed-in user')).toBeTruthy();
    });

    it('leaves a flowlet input alone — no viewer, no app', () => {
        renderTrigger({ id: 'trg', type: 'trigger', kind: 'layer_input', params: [] });
        expect(screen.getByText('no inputs')).toBeTruthy();
        expect(screen.queryByText('Signed-in user')).toBeNull();
        expect(authFetch).not.toHaveBeenCalled();
    });
});
