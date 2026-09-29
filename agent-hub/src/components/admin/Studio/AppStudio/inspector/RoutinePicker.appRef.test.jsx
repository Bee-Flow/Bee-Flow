import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../utils/helpers', async (importOriginal) => ({
    ...(await importOriginal()),
    API_BASE: '',
    authFetch: (...args) => authFetch(...args),
}));

import RoutinePicker from './RoutinePicker';

/**
 * "Make a routine for this app" has to record WHICH BUTTON it was made from.
 *
 * Without the back-pointer, a routine made from here is indistinguishable in
 * the builder from one typed up by hand: the same nameless Studio App trigger,
 * no trail back to the screen, and nothing to say when that screen is later
 * deleted. The reference is a label only — it never grants anything — so the
 * rule that matters is that it is WHOLE or absent, never partial.
 */

const authFetch = vi.fn();
const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

const REF = { appId: '5f2a1c34-8b7d-4e19-9f00-2ab3c4d5e6f7', screenId: 'scr_dash01', nodeId: 'cmp_btn123' };

/** The POST body the picker sent, parsed. */
function createdDefinition() {
    const call = authFetch.mock.calls.find(([url, init]) => init?.method === 'POST' && String(url).includes('/api/automation'));
    expect(call, 'no routine was created').toBeTruthy();
    return JSON.parse(call[1].body).definition;
}

async function makeRoutine(props) {
    authFetch.mockImplementation(async (url, init) => {
        if (init?.method === 'POST') return ok({ automation: { id: 'aut_new', title: 'New routine for this app' } });
        return ok({ automations: [] });
    });
    render(<RoutinePicker open onClose={() => {}} onPick={() => {}} formFields={[]} {...props} />);
    const button = await screen.findByRole('button', { name: /Make a routine for this app/ });
    await userEvent.click(button);
    await waitFor(() => expect(authFetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true));
}

beforeEach(() => { cleanup(); authFetch.mockReset(); });
afterEach(cleanup);

describe('CreateRoutineRow — the back-pointer', () => {
    it('records the app, the screen and the button on the trigger', async () => {
        await makeRoutine({ appRef: REF });
        const def = createdDefinition();
        expect(def.trigger.kind).toBe('app_trigger');
        expect(def.trigger.appRef).toEqual(REF);
    });

    it('writes NO back-pointer when there is no reference to write', async () => {
        // The editor can be mounted without an app id (tests, the headless
        // runtime). No pointer is a routine with nothing to say about its
        // origin; a guessed one is a routine that says something false.
        await makeRoutine({ appRef: null });
        expect(createdDefinition().trigger).not.toHaveProperty('appRef');
    });

    it('writes NO back-pointer for a partial reference', async () => {
        // Two thirds of a pointer names nothing, and the server rejects it at
        // save time — so the routine would be created and then be unsaveable.
        await makeRoutine({ appRef: { appId: REF.appId, screenId: REF.screenId } });
        expect(createdDefinition().trigger).not.toHaveProperty('appRef');
    });

    it('carries nothing beyond the three ids', async () => {
        // A name resolved in the app editor must not be frozen into the
        // definition: whether the viewer of the BUILDER may read it is a
        // different question, answered per viewer, server-side.
        await makeRoutine({ appRef: { ...REF, appName: 'Expenses', canOpen: true } });
        expect(Object.keys(createdDefinition().trigger.appRef).sort()).toEqual(['appId', 'nodeId', 'screenId']);
    });
});

describe('CreateRoutineRow — what the row says it will make', () => {
    it('picks the plural by KEY, never by gluing an s onto a word', async () => {
        // "input(s)" is not a sentence, and most languages do not form a
        // plural by suffix at all.
        authFetch.mockResolvedValue(ok({ automations: [] }));
        const { rerender } = render(
            <RoutinePicker open onClose={() => {}} onPick={() => {}} formFields={[{ name: 'title', type: 'input_text' }]} />,
        );
        expect(await screen.findByText('It starts with 1 input matching this form.')).toBeTruthy();
        rerender(
            <RoutinePicker
                open
                onClose={() => {}}
                onPick={() => {}}
                formFields={[{ name: 'title', type: 'input_text' }, { name: 'amount', type: 'input_number' }]}
            />,
        );
        expect(await screen.findByText('It starts with 2 inputs matching this form.')).toBeTruthy();
        expect(screen.queryByText(/input\(s\)/)).toBeNull();
    });
});
