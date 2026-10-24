import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * App Studio runtime — `_appEffects`: what an automation INSTRUCTS the app to do
 * when it is done (P4, part B).
 *
 * ── NO NEW CHANNEL ───────────────────────────────────────────────────────────
 * The app runtime already polls the run. `_appEffects` travels as a SIBLING field
 * next to `output` in that same response, so there is nothing new to subscribe to —
 * and `output` remains exactly what every existing `actionResult` binding reads.
 *
 * ── WHAT IS PROVEN HERE ──────────────────────────────────────────────────────
 *   1. the three effects are really applied: notification, screen (with record)
 *      and refresh;
 *   2. the automation wins PER KEY over what the app author wrote on the action —
 *      it knows what actually happened;
 *   3. an effect this app does NOT KNOW is skipped without dropping the effects
 *      it does know, and never silently;
 *   4. an effect that is not EXECUTABLE here (a screen the app does not have,
 *      `resetForm` without a form) falls back to `onError` — `stay` narrows,
 *      `errorScreen` says so out loud.
 *
 * Run: cd agent-hub && ./node_modules/.bin/vitest run \
 *   src/components/admin/Studio/AppStudio/runtime/useActionRunner.appEffects.test.jsx
 */

vi.mock('../../../../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('../../../../shared/Toast', () => {
    const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
    return { default: toast, toast };
});
vi.mock('./components/AppModal', () => ({ openAppModal: vi.fn(), closeAppModal: vi.fn() }));
vi.mock('./formContext', () => ({ resetAppForm: vi.fn() }));

import { resetAppForm } from './formContext';
import useActionRunner from './useActionRunner';
import { authFetch } from '../../../../../utils/helpers';
import toast from '../../../../shared/Toast';

const resp = (status, body, ok = status >= 200 && status < 300) => ({ ok, status, json: async () => body });

/** An app with two screens, one action that runs an automation. */
function def(action = { kind: 'run_automation', automationId: 'aut_1' }) {
    return {
        schemaVersion: 2,
        screens: [{ id: 'scr_home', name: 'Home' }, { id: 'scr_orders', name: 'Orders' }],
        actions: { go: action },
    };
}

let warn;
beforeEach(() => {
    authFetch.mockReset();
    toast.success.mockReset();
    toast.error.mockReset();
    toast.info.mockReset();
    resetAppForm.mockReset();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { warn.mockRestore(); });

describe('_appEffects — the automation answers the app', () => {
    it('applies the toast, the screen (with its record) and the refresh', async () => {
        authFetch.mockResolvedValue(resp(200, {
            runId: 'run_1',
            status: 'success',
            output: { rows: [{ id: 'ord_7' }] },
            _appEffects: {
                toast: { message: 'Saved Acme', tone: 'success' },
                navigateTo: { screenId: 'scr_orders', params: { id: 'ord_7' } },
                refresh: 'tableViews',
                onError: 'stay',
            },
        }));
        const onNavigate = vi.fn();
        const onRefresh = vi.fn().mockResolvedValue(undefined);
        const { result } = renderHook(() => useActionRunner('app1', def(), { onNavigate, onRefresh }));

        await act(async () => { await result.current.runAction('go'); });

        expect(toast.success).toHaveBeenCalledWith('Saved Acme');
        expect(onNavigate).toHaveBeenCalledWith('scr_orders', { id: 'ord_7' });
        expect(onRefresh).toHaveBeenCalled();
    });

    it('leaves `output` alone — actionResult still reads the automation’s data', async () => {
        authFetch.mockResolvedValue(resp(200, {
            runId: 'run_1', status: 'success', output: { rows: [{ id: 'ord_7' }] },
            _appEffects: { toast: { message: 'Saved' } },
        }));
        const { result } = renderHook(() => useActionRunner('app1', def(), {}));

        await act(async () => { await result.current.runAction('go'); });

        expect(result.current.actionState.go.status).toBe('success');
        expect(result.current.actionState.go.result).toMatchObject({ output: { rows: [{ id: 'ord_7' }] } });
    });

    it('a run with no effects behaves exactly as before', async () => {
        authFetch.mockResolvedValue(resp(200, { runId: 'run_1', status: 'success', output: { n: 1 } }));
        const onNavigate = vi.fn();
        const onRefresh = vi.fn();
        const { result } = renderHook(() => useActionRunner('app1', def(), { onNavigate, onRefresh }));

        await act(async () => { await result.current.runAction('go'); });

        expect(onNavigate).not.toHaveBeenCalled();
        expect(onRefresh).not.toHaveBeenCalled();
        expect(toast.success).not.toHaveBeenCalled();
    });

    it('the automation wins PER KEY over what the app author wrote on the action', async () => {
        authFetch.mockResolvedValue(resp(200, {
            runId: 'run_1', status: 'success', output: null,
            // The automation only asks for a navigation; the author's toast stands.
            _appEffects: { navigateTo: { screenId: 'scr_orders' } },
        }));
        const onNavigate = vi.fn();
        const action = {
            kind: 'run_automation',
            automationId: 'aut_1',
            onSuccess: { toast: { message: 'Author message', tone: 'info' }, navigateTo: 'scr_home' },
        };
        const { result } = renderHook(() => useActionRunner('app1', def(action), { onNavigate }));

        await act(async () => { await result.current.runAction('go'); });

        expect(toast.info).toHaveBeenCalledWith('Author message');
        expect(onNavigate).toHaveBeenCalledTimes(1);
        expect(onNavigate).toHaveBeenCalledWith('scr_orders');
    });

    it('an authored navigateTo STRING keeps working — the old shape is not dropped', async () => {
        authFetch.mockResolvedValue(resp(200, { runId: 'run_1', status: 'success', output: null }));
        const onNavigate = vi.fn();
        const action = { kind: 'run_automation', automationId: 'aut_1', onSuccess: { navigateTo: 'scr_orders' } };
        const { result } = renderHook(() => useActionRunner('app1', def(action), { onNavigate }));

        await act(async () => { await result.current.runAction('go'); });

        expect(onNavigate).toHaveBeenCalledWith('scr_orders');
    });
});

describe('_appEffects — an effect this app cannot do is ignored, but never silently', () => {
    it('skips an unknown effect key, says so, and still applies the ones it knows', async () => {
        authFetch.mockResolvedValue(resp(200, {
            runId: 'run_1', status: 'success', output: null,
            _appEffects: { toast: { message: 'Saved' }, printReceipt: { copies: 2 } },
        }));
        const { result } = renderHook(() => useActionRunner('app1', def(), {}));

        await act(async () => { await result.current.runAction('go'); });

        // The known half still happened…
        expect(toast.info).toHaveBeenCalledWith('Saved');
        // …and the unknown half is reported by name.
        expect(warn.mock.calls.flat().join(' ')).toContain('printReceipt');
    });

    it('a screen this app does not have is not navigated to — and with `stay` the visitor is left alone', async () => {
        authFetch.mockResolvedValue(resp(200, {
            runId: 'run_1', status: 'success', output: null,
            _appEffects: { navigateTo: { screenId: 'scr_gone' }, onError: 'stay' },
        }));
        const onNavigate = vi.fn();
        const { result } = renderHook(() => useActionRunner('app1', def(), { onNavigate }));

        await act(async () => { await result.current.runAction('go'); });

        expect(onNavigate).not.toHaveBeenCalled();
        expect(toast.error).not.toHaveBeenCalled();
        expect(warn.mock.calls.flat().join(' ')).toContain('scr_gone');
    });

    it('…and with `errorScreen` the visitor is told instead of being left guessing', async () => {
        authFetch.mockResolvedValue(resp(200, {
            runId: 'run_1', status: 'success', output: null,
            _appEffects: { navigateTo: { screenId: 'scr_gone' }, onError: 'errorScreen' },
        }));
        const onNavigate = vi.fn();
        const { result } = renderHook(() => useActionRunner('app1', def(), { onNavigate }));

        await act(async () => { await result.current.runAction('go'); });

        expect(onNavigate).not.toHaveBeenCalled();
        expect(toast.error).toHaveBeenCalledTimes(1);
        expect(toast.error.mock.calls[0][0]).toContain('scr_gone');
    });

    /**
     * THE KEY OF THE RESET BUS IS THE FORM NAME, NOT THE NODE ID.
     *
     * AppForm registers its resetter under `props.name || node.id`, and canonicalize
     * guarantees that `props.name` is filled (`frm_<suffix>`) — while AppForm passed
     * its NODE id as `formId`. Those two are therefore by definition never equal:
     * `resetAppForm` did silently nothing for an unknown name, the form stayed filled
     * in, and because `formId` IS a non-empty string the “there is no form here”
     * branch was never reached either. No toast, no console line, no onError.
     */
    it('resetForm ruimt het formulier op onder de NAAM waaronder het zich meldt', async () => {
        authFetch.mockResolvedValue(resp(200, {
            runId: 'run_1', status: 'success', output: null, _appEffects: { refresh: 'resetForm' },
        }));
        const { result } = renderHook(() => useActionRunner('app1', def(), {}));

        // Wat AppForm werkelijk meestuurt: het node-id én de naam.
        await act(async () => {
            await result.current.runAction('go', { formId: 'cmp_form01', formName: 'frm_new_order' });
        });

        expect(resetAppForm).toHaveBeenCalledWith('frm_new_order');
        expect(resetAppForm).not.toHaveBeenCalledWith('cmp_form01');
    });

    it('zonder naam valt hij terug op het id — een formulier zonder naam IS zijn id', async () => {
        authFetch.mockResolvedValue(resp(200, {
            runId: 'run_1', status: 'success', output: null, _appEffects: { refresh: 'resetForm' },
        }));
        const { result } = renderHook(() => useActionRunner('app1', def(), {}));

        await act(async () => { await result.current.runAction('go', { formId: 'cmp_form01' }); });

        expect(resetAppForm).toHaveBeenCalledWith('cmp_form01');
    });

    it('en AppForm stuurt allebei mee — anders is de sleutel hierboven fictie', async () => {
        // This whole test above depends on what AppForm actually passes;
        // without this line it only confirms its own fixture.
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(
            path.resolve(process.cwd(), 'src/components/admin/Studio/AppStudio/runtime/components/AppForm.tsx'),
            'utf8',
        );
        expect(src).toContain('runAction(node.onSubmit, { formValues: { ...values }, formId: node.id, formName });');
        expect(src).toMatch(/const formName = node\.props\?\.name \|\| node\.id;/);
    });

    it('resetForm from a button with no form behind it reports rather than guessing which form to clear', async () => {
        authFetch.mockResolvedValue(resp(200, {
            runId: 'run_1', status: 'success', output: null,
            _appEffects: { refresh: 'resetForm', onError: 'errorScreen' },
        }));
        const { result } = renderHook(() => useActionRunner('app1', def(), {}));

        await act(async () => { await result.current.runAction('go'); });

        expect(resetAppForm).not.toHaveBeenCalled();
        expect(toast.error).toHaveBeenCalledTimes(1);
    });
});

describe('_appEffects — the 202 + poll path and the sequence path carry it too', () => {
    it('an accepted run picks its effects up from the POLL answer', async () => {
        authFetch
            .mockResolvedValueOnce(resp(202, { runId: 'run_1', status: 'pending' }))
            .mockResolvedValue(resp(200, {
                runId: 'run_1', status: 'success', output: null,
                _appEffects: { toast: { message: 'Finished', tone: 'success' } },
            }));
        const { result } = renderHook(() => useActionRunner('app1', def(), {}));

        vi.useFakeTimers();
        try {
            const run = act(async () => { await result.current.runAction('go'); });
            await vi.advanceTimersByTimeAsync(2500);
            await run;
        } finally {
            vi.useRealTimers();
        }

        expect(toast.success).toHaveBeenCalledWith('Finished');
    });

    it('a run_automation STEP inside a sequence applies its effects once, at the end', async () => {
        // Two steps: first the automation (which returns to scr_orders), then
        // another write step. Were the effect applied immediately, the app would
        // navigate away before that second step.
        authFetch
            .mockResolvedValueOnce(resp(200, {
                ok: true,
                result: { runId: 'run_1', status: 'success', output: null, _appEffects: { navigateTo: { screenId: 'scr_orders' } } },
            }))
            .mockResolvedValueOnce(resp(200, { ok: true, result: { id: 'rec_2' } }));
        const onNavigate = vi.fn();
        const definition = {
            schemaVersion: 2,
            screens: [{ id: 'scr_home', name: 'Home' }, { id: 'scr_orders', name: 'Orders' }],
            actions: {
                go: {
                    kind: 'sequence',
                    steps: [
                        { kind: 'run_automation', automationId: 'aut_1' },
                        { kind: 'create_record', tableId: 't', values: {} },
                    ],
                },
            },
        };
        const { result } = renderHook(() => useActionRunner('app1', definition, { onNavigate }));

        await act(async () => { await result.current.runAction('go'); });

        expect(authFetch).toHaveBeenCalledTimes(2);
        expect(onNavigate).toHaveBeenCalledTimes(1);
        expect(onNavigate).toHaveBeenCalledWith('scr_orders');
    });
});

/**
 * CLOSED VOCABULARIES, WITH A CLOSING BRANCH.
 *
 * `refresh` is a closed set on the server side
 * (validate/constants.js RETURN_TO_APP_REFRESH_MODES), but it travels as DATA
 * to an app bundle that can be OLDER than the automation. `KNOWN_EFFECT_KEYS`
 * catches an unknown KEY; an unknown VALUE of a known key was caught nowhere and
 * disappeared silently — precisely the effect the docblock of this function
 * promises never to let vanish.
 */
describe('_appEffects — een waarde buiten het vocabulaire verdwijnt niet stil', () => {
    it('meldt een refresh-modus die deze app-versie niet kent', async () => {
        authFetch.mockResolvedValue(resp(200, {
            runId: 'run_1', status: 'success', output: null,
            _appEffects: { refresh: 'everything', onError: 'errorScreen' },
        }));
        const { result } = renderHook(() => useActionRunner('app1', def(), { onRefresh: vi.fn() }));

        await act(async () => { await result.current.runAction('go'); });

        expect(toast.error).toHaveBeenCalledTimes(1);
        expect(toast.error.mock.calls[0][0]).toContain('everything');
    });

    it('tableViews zonder databron meldt dat óók — net als resetForm zonder formulier', async () => {
        // Asymmetrie was het probleem: de resetForm-tak zei "there is no form
        // here to clear" en de tableViews-tak deed simpelweg niets.
        authFetch.mockResolvedValue(resp(200, {
            runId: 'run_1', status: 'success', output: null,
            _appEffects: { refresh: 'tableViews', onError: 'errorScreen' },
        }));
        const { result } = renderHook(() => useActionRunner('app1', def(), {}));

        await act(async () => { await result.current.runAction('go'); });

        expect(toast.error).toHaveBeenCalledTimes(1);
        expect(toast.error.mock.calls[0][0]).toMatch(/reload/i);
    });

    it('en met een databron gebeurt er gewoon niets bijzonders', async () => {
        authFetch.mockResolvedValue(resp(200, {
            runId: 'run_1', status: 'success', output: null,
            _appEffects: { refresh: 'tableViews', onError: 'errorScreen' },
        }));
        const onRefresh = vi.fn().mockResolvedValue(undefined);
        const { result } = renderHook(() => useActionRunner('app1', def(), { onRefresh }));

        await act(async () => { await result.current.runAction('go'); });

        expect(onRefresh).toHaveBeenCalled();
        expect(toast.error).not.toHaveBeenCalled();
    });
});

/**
 * THE THIRD STATE: THE SERVER COULD NOT READ THE INSTRUCTIONS.
 *
 * `_appEffectsUnknown` means the run succeeded but reading the steps failed
 * (server/appStudio/actionExecutor/automationBridge.js). Without a branch of its
 * own, that answer cannot be told apart from “this automation had no return step”:
 * no notification, no navigation, no trace.
 */
describe('_appEffectsUnknown — onleesbaar is niet hetzelfde als leeg', () => {
    it('zegt het hardop wanneer de actie op errorScreen staat', async () => {
        authFetch.mockResolvedValue(resp(200, {
            runId: 'run_1', status: 'success', output: null, _appEffectsUnknown: true,
        }));
        const { result } = renderHook(() => useActionRunner(
            'app1', def({ kind: 'run_automation', automationId: 'aut_1', onSuccess: { onError: 'errorScreen' } }), {},
        ));

        await act(async () => { await result.current.runAction('go'); });

        expect(toast.error).toHaveBeenCalledTimes(1);
        expect(toast.error.mock.calls[0][0]).toMatch(/could not be read/i);
    });

    it('en laat anders in elk geval een regel achter in plaats van niets', async () => {
        authFetch.mockResolvedValue(resp(200, {
            runId: 'run_1', status: 'success', output: null, _appEffectsUnknown: true,
        }));
        const { result } = renderHook(() => useActionRunner('app1', def(), {}));

        await act(async () => { await result.current.runAction('go'); });

        expect(warn).toHaveBeenCalled();
        expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/could not be read/i);
    });

    it('een gewoon antwoord zonder de vlag zegt niets — dit is geen nieuwe ruis', async () => {
        authFetch.mockResolvedValue(resp(200, { runId: 'run_1', status: 'success', output: { n: 1 } }));
        const { result } = renderHook(() => useActionRunner('app1', def(), {}));

        await act(async () => { await result.current.runAction('go'); });

        expect(warn).not.toHaveBeenCalled();
        expect(toast.error).not.toHaveBeenCalled();
    });
});
