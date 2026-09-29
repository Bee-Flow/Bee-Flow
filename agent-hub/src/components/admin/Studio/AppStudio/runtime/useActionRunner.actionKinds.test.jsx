import { act, renderHook } from '@testing-library/react';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ACTION-kind lockstep — the half `useActionRunner.stepKinds.test.js` does not
 * cover.
 *
 * That file pins the STEP catalog (what runs INSIDE a sequence). Nothing pinned
 * the top-level ACTION catalog, and `runAction` is a switch whose `default:`
 * branch returns. A bare action of a kind the switch has no case for therefore
 * does NOTHING — no request, no toast, no error state. The button is dead and
 * the app says nothing about it.
 *
 * That is not hypothetical: `create_record` is a step kind the server has
 * executed for a year, and the moment it became an ACTION kind too it landed in
 * exactly that hole. A silent no-op is worse than a crash — it lies.
 *
 * So this test is BEHAVIOURAL, not a list comparison: it drives the real hook
 * once per server ACTION_KIND and demands that something observable happened —
 * a request, a navigation, a toast, a modal, a window, or an explicit error
 * state. A declared "handled kinds" array could drift from the switch; an
 * observation cannot.
 */

vi.mock('../../../../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('../../../../shared/Toast', () => {
    const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
    return { default: toast, toast };
});
vi.mock('./components/AppModal', () => ({ openAppModal: vi.fn(), closeAppModal: vi.fn() }));

import { closeAppModal, openAppModal } from './components/AppModal';
import useActionRunner from './useActionRunner';
import { authFetch } from '../../../../../utils/helpers';
import toast from '../../../../shared/Toast';

const require = createRequire(import.meta.url);
const { ACTION_KINDS } = require('../../../../../../../server/appStudio/componentSpecs.js');

const resp = (status, body, ok = status >= 200 && status < 300) => ({ ok, status, json: async () => body });

/**
 * The sentence runAction's `default:` branch produces for a kind it has no case
 * for. Pinned by its own test below, so this marker cannot quietly stop
 * matching and take the per-kind assertions' teeth with it.
 */
const UNKNOWN_KIND_MARKER = /this version cannot run/i;

/**
 * The smallest bare action of each kind that a user could actually have wired.
 *
 * Adding a kind to the server catalog without adding it here fails the coverage
 * test below — deliberately. "How does this run in the browser?" is a question
 * a new action kind has to answer before it ships, not after a user finds a
 * button that does nothing.
 */
const FIXTURES = {
    run_automation: { kind: 'run_automation', automationId: 'aut_1' },
    ai_extract: { kind: 'ai_extract', source: { kind: 'static', value: 'x' }, schema: [{ name: 'a', type: 'string' }] },
    ai_generate: { kind: 'ai_generate', prompt: 'hi', output: 'text', resultVar: 'out' },
    kb_query: { kind: 'kb_query', query: { kind: 'static', value: 'q' }, knowledgeBaseIds: ['kb_1'], resultVar: 'hits' },
    send_email: { kind: 'send_email', connectorId: 'c1', to: { kind: 'static', value: 'a@b.test' }, subject: { kind: 'static', value: 's' }, body: { kind: 'static', value: 'b' } },
    create_record: { kind: 'create_record', tableId: 'tbl_1', values: {} },
    navigate: { kind: 'navigate', screenId: 'scr_1' },
    toast: { kind: 'toast', message: 'done', tone: 'info' },
    open_url: { kind: 'open_url', url: 'https://example.test/', newTab: true },
    open_modal: { kind: 'open_modal', modalId: 'cmp_m1' },
    close_modal: { kind: 'close_modal', modalId: 'cmp_m1' },
    sequence: { kind: 'sequence', steps: [{ kind: 'toast', message: 'step' }] },
};

/** Run one bare action through the real hook and report what it did. */
async function observe(action, opts = {}) {
    const definition = { schemaVersion: 2, actions: { act_1: action } };
    const onNavigate = vi.fn();
    const openWindow = vi.fn();
    const realOpen = window.open;
    window.open = openWindow;
    try {
        const { result } = renderHook(() => useActionRunner('app1', definition, { onNavigate, ...opts }));
        await act(async () => { await result.current.runAction('act_1'); });
        const entry = result.current.actionState.act_1 || {};
        return {
            fetched: authFetch.mock.calls.length > 0,
            navigated: onNavigate.mock.calls.length > 0,
            toasted: toast.info.mock.calls.length + toast.error.mock.calls.length + toast.success.mock.calls.length > 0,
            opened: openWindow.mock.calls.length > 0,
            modal: openAppModal.mock.calls.length + closeAppModal.mock.calls.length > 0,
            errored: entry.status === 'error',
            status: entry.status,
            // Did it land in runAction's "I do not know this kind" branch?
            // `errored` alone cannot answer that, and the difference is the
            // whole point: an unknown kind SHOULD error, a known one must not.
            unknownFallback: UNKNOWN_KIND_MARKER.test(String(entry.error || '')),
        };
    } finally {
        window.open = realOpen;
    }
}

const didSomething = (o) => o.fetched || o.navigated || o.toasted || o.opened || o.modal || o.errored;

describe('runAction — every action kind the server ships does something', () => {
    beforeEach(() => {
        authFetch.mockReset();
        authFetch.mockResolvedValue(resp(200, { ok: true, result: {} }));
        toast.success.mockReset();
        toast.error.mockReset();
        toast.info.mockReset();
        openAppModal.mockReset();
        closeAppModal.mockReset();
    });
    afterEach(() => { vi.useRealTimers(); });

    it('has a fixture for every kind in the server catalog', () => {
        expect(Object.keys(FIXTURES).sort()).toEqual([...ACTION_KINDS].sort());
    });

    for (const kind of ACTION_KINDS) {
        it(`${kind}: is not a silent no-op, and is not the unknown-kind fallback`, async () => {
            const observed = await observe(FIXTURES[kind]);
            expect(
                didSomething(observed),
                `a bare "${kind}" action did nothing at all: no request, no navigation, no toast, no window, no modal, and no error state`,
            ).toBe(true);
            // Without this second half the test does not bite for the kinds
            // handled purely in the browser. Deleting `case 'navigate'` sends
            // it to the default branch, which errors — and `didSomething` was
            // satisfied by that error, so the assertion stayed green while the
            // feature was gone. A kind the server ships must be HANDLED here,
            // not merely reported as unhandled.
            expect(
                observed.unknownFallback,
                `"${kind}" fell through runAction's switch into the unknown-kind branch — the server ships it, so this build has to run it`,
            ).toBe(false);
        });
    }

    /**
     * The server-executed kinds must reach the /step endpoint. Asserting only
     * "something happened" would let a kind pass by toasting an error — which
     * is honest, but it is not the feature.
     */
    const SERVER_EXECUTED = ['ai_extract', 'ai_generate', 'kb_query', 'send_email', 'create_record'];
    for (const kind of SERVER_EXECUTED) {
        it(`${kind}: dispatches to the server step endpoint`, async () => {
            await observe(FIXTURES[kind]);
            expect(authFetch).toHaveBeenCalled();
            expect(String(authFetch.mock.calls[0][0])).toContain('/actions/act_1/step');
        });
    }

    /**
     * The failure this whole file exists for. An action whose kind this build
     * does not know must SAY so — the old `default: return` left the control
     * looking like it had worked.
     */
    it('an unknown kind surfaces an error instead of doing nothing', async () => {
        const observed = await observe({ kind: 'teleport_user', target: 'mars' });
        expect(observed.errored).toBe(true);
        expect(toast.error).toHaveBeenCalled();
        // Pins UNKNOWN_KIND_MARKER against the real message. If the wording
        // changes, this fails here rather than silently un-arming the per-kind
        // assertions above.
        expect(observed.unknownFallback).toBe(true);
    });
});
