import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * App Studio runtime — `_appEffects`: wat een automatisering de app OPDRAAGT als hij
 * klaar is (P4, deel B).
 *
 * ── GEEN NIEUW KANAAL ───────────────────────────────────────────────────────
 * De app-runtime pollt de run al. `_appEffects` reist als ZUSTERVELD naast
 * `output` in datzelfde antwoord, dus er is niets nieuws om op te abonneren —
 * en `output` blijft precies wat elke bestaande `actionResult`-binding leest.
 *
 * ── WAT HIER WORDT BEWEZEN ──────────────────────────────────────────────────
 *   1. de drie effecten worden echt toegepast: melding, scherm (mét record) en
 *      verversen;
 *   2. de automatisering wint PER SLEUTEL van wat de app-auteur op de actie schreef —
 *      hij weet wat er werkelijk gebeurd is;
 *   3. een effect dat deze app niet KENT wordt overgeslagen zonder de effecten
 *      die hij wél kent mee te nemen, en nooit stil;
 *   4. een effect dat hier niet UITVOERBAAR is (een scherm dat de app niet
 *      heeft, `resetForm` zonder formulier) valt terug op `onError` — `stay`
 *      versmalt, `errorScreen` zegt het hardop.
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

import useActionRunner from './useActionRunner';
import { authFetch } from '../../../../../utils/helpers';
import toast from '../../../../shared/Toast';
import { resetAppForm } from './formContext';

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
     * DE SLEUTEL VAN DE RESET-BUS IS DE FORM-NAAM, NIET HET NODE-ID.
     *
     * AppForm registreert zijn resetter onder `props.name || node.id`, en
     * canonicalize garandeert dat `props.name` gevuld is (`frm_<suffix>`) —
     * terwijl AppForm zijn NODE-id als `formId` meestuurde. Die twee zijn dus
     * per definitie nooit gelijk: `resetAppForm` deed stil niets voor een
     * onbekende naam, het formulier bleef ingevuld staan, en omdat `formId`
     * een niet-lege string IS werd de "er is hier geen formulier"-tak ook nooit
     * bereikt. Geen toast, geen console-regel, geen onError.
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
        // De hele bovenstaande test hangt aan wat AppForm werkelijk doorgeeft;
        // zonder deze regel bevestigt hij alleen zijn eigen fixture.
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(
            path.resolve(process.cwd(), 'src/components/admin/Studio/AppStudio/runtime/components/AppForm.jsx'),
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
        // Twee stappen: eerst de automatisering (die terugkeert naar scr_orders), dan
        // nog een schrijfstap. Zou het effect meteen worden toegepast, dan
        // navigeerde de app weg vóór die tweede stap.
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
 * GESLOTEN VOCABULAIRES, MET EEN AFSLUITENDE TAK.
 *
 * `refresh` is een gesloten set aan de serverkant
 * (validate/constants.js RETURN_TO_APP_REFRESH_MODES), maar hij reist als DATA
 * naar een app-bundel die OUDER kan zijn dan de automation. `KNOWN_EFFECT_KEYS`
 * vangt een onbekende SLEUTEL; een onbekende WAARDE van een bekende sleutel
 * werd nergens gevangen en verdween stil — precies het effect dat de docblock
 * van deze functie belooft nooit te laten verdwijnen.
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
 * DE DERDE STAND: DE SERVER KON DE INSTRUCTIES NIET LEZEN.
 *
 * `_appEffectsUnknown` betekent dat de run slaagde maar de stappenlees omviel
 * (server/appStudio/actionExecutor/automationBridge.js). Zonder een eigen tak
 * is dat antwoord niet te onderscheiden van "deze automatisering had geen
 * terugkeerstap": geen melding, geen navigatie, geen spoor.
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
