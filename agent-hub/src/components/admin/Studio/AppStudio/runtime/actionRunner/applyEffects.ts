/**
 * Apply an EFFECT OBJECT — "what happens when the action is done".
 *
 * Two sources, one shape. The app author writes `action.onSuccess` /
 * `action.onError` in the inspector; an automation writes the same shape from
 * a `return_to_app` step and it reaches here as `_appEffects` on the run
 * result. The automation's keys are merged OVER the author's at the call
 * sites: it knows what actually happened, the author only knew what was
 * intended.
 *
 * ── NOTHING DISAPPEARS SILENTLY ─────────────────────────────────────────
 * Two kinds of "this does not work", and both are reported:
 *   1. AN EFFECT THIS APP DOES NOT KNOW. An automation can be newer than the
 *      app bundle that runs it. Unknown keys are skipped — never a crash, and
 *      never at the cost of the keys we DO know — but a line goes to the
 *      console. The server side has already recorded what it sent at that
 *      point (the `return_to_app` step writes `_appEffects` and `_ignored`
 *      into its own run row), so "what did the automation ask for" can always
 *      be read back in the run log.
 *   2. AN EFFECT THAT CANNOT BE CARRIED OUT HERE — a screen this app does not
 *      have, or `resetForm` while no form started the action. Then `onError`
 *      decides: `stay` leaves the visitor where they are (the narrowing
 *      default), `errorScreen` says it out loud.
 *
 * `errorScreen` shows a danger toast today and does not navigate: App Studio
 * has no separate error screen yet, and jumping to a screen we would have to
 * GUESS is exactly the mistake this branch is meant to catch. Once an app
 * does point at one, this is the place.
 */
import { resetAppForm } from '../formContext';
import { showToast } from './core';
import type { EffectObject, Translate } from './core';

// The effect keys this build knows how to apply. Anything else in an effect
// object is skipped — and said out loud (see applyEffects). Kept as an explicit
// ALLOW-LIST rather than a "skip the ones I don't like" list so a key added on
// the server side shows up as an unknown here instead of being applied by
// accident through a generic loop.
const KNOWN_EFFECT_KEYS = new Set(['toast', 'navigateTo', 'refresh', 'onError']);

/** Where the action came from: the form that started it, and whether its effects were readable. */
export interface EffectContext {
    formId?: string;
    formName?: string;
    effectsUnknown?: boolean;
}

/** The live host callbacks applyEffects reads at call time (the hook passes its refs). */
export interface EffectHost {
    tr: Translate;
    screens: () => unknown;
    navigate: () => ((screenId: string, params?: unknown) => void) | null | undefined;
    refresh: () => (() => unknown) | null | undefined;
}

/**
 * "The automation finished, but this did not work here." One place, so every
 * kind of failure takes the same way out: `onError:'errorScreen'` tells the
 * visitor out loud, `stay` (the narrowing default, and also what an UNKNOWN
 * onError yields) leaves a line in the console.
 */
function reportEffectFailures(failures: string[], onError: unknown, tr: Translate): void {
    if (!failures.length) return;
    const message = tr('studio_apps_runtime.actions.effects_finished_but', 'The automation finished, but {failures}.', {
        failures: failures.join(tr('studio_apps_runtime.actions.join_and', ' and ')),
    });
    if (onError === 'errorScreen') showToast('danger', message);
    else console.warn(`[AppStudio] ${message}`);
}

function warnUnknownKeys(effects: EffectObject): void {
    const unknown = Object.keys(effects).filter((k) => !KNOWN_EFFECT_KEYS.has(k));
    if (!unknown.length) return;
    console.warn(
        `[AppStudio] The automation asked for ${unknown.map((k) => `"${k}"`).join(', ')}, `
        + 'which this version of the app cannot do — ignored. The run log records what it sent.',
    );
}

// `navigateTo` has two shapes and both stay supported: the STRING an
// authored onSuccess effect has always carried, and the OBJECT a
// return_to_app step produces ({ screenId, params }) so the next screen
// can open one record.
function applyNavigate(effects: EffectObject, host: EffectHost, failures: string[]): void {
    const nav = effects.navigateTo;
    const screenId = typeof nav === 'string'
        ? nav
        : (nav && typeof nav === 'object' ? nav.screenId : null);
    if (!screenId) return;
    const screens = host.screens();
    // No list = not checkable, and then the behaviour stays as it was. Only a
    // list that DEMONSTRABLY lacks the screen is a failure; otherwise an app
    // without a screens array could no longer navigate.
    const missing = Array.isArray(screens) && !screens.some((sc) => sc && sc.id === screenId);
    if (missing) {
        failures.push(host.tr('studio_apps_runtime.actions.failure_screen_missing', 'the screen “{screen}” is not part of this app', { screen: String(screenId) }));
        return;
    }
    const navigate = host.navigate();
    if (!navigate) return;
    // Without params, exactly the call that always stood here (one argument).
    // A second argument that is `undefined` behaves the same but does change
    // what every observing test and every onNavigate implementation gets to
    // see — and that is a change without a reason.
    const params = (nav && typeof nav === 'object') ? nav.params : null;
    if (params) navigate(screenId, params);
    else navigate(screenId);
}

// `refresh` is a CLOSED vocabulary (validate/constants.js
// RETURN_TO_APP_REFRESH_MODES), and a closed vocabulary that travels as DATA
// needs a closing branch: this app bundle can be older than the automation
// driving it. KNOWN_EFFECT_KEYS catches an unknown KEY; without the final
// `else` below an unknown VALUE of a known key silently disappeared.
async function applyRefresh(effects: EffectObject, ctx: EffectContext, host: EffectHost, failures: string[]): Promise<void> {
    const { tr } = host;
    if (effects.refresh === 'tableViews') {
        // Symmetric with resetForm: if no data source has registered, that is
        // a failure and not a non-action. Without this line nothing happened
        // and nothing was reported either.
        const refresh = host.refresh();
        if (refresh) {
            try { await refresh(); } catch { failures.push(tr('studio_apps_runtime.actions.failure_reload', 'the data could not be reloaded')); }
        } else {
            failures.push(tr('studio_apps_runtime.actions.failure_no_data', 'there is no data on this screen to reload'));
        }
    } else if (effects.refresh === 'resetForm') {
        // Only the form that started THIS action. Clearing every form on the
        // screen would also wipe the filter bar the visitor had just set.
        //
        // The bus is keyed on the form NAME (`props.name || node.id`, and
        // canonicalize guarantees `props.name` is filled), while AppForm sent
        // its NODE id as `formId`. Those two are therefore by definition never
        // equal, and `resetAppForm` silently does nothing for an unknown name
        // — the form stayed filled in and nobody heard about it. Hence
        // `formName` as the key, with `formId` as the fallback for a form
        // without a name.
        const formKey = (typeof ctx.formName === 'string' && ctx.formName)
            ? ctx.formName
            : ((typeof ctx.formId === 'string' && ctx.formId) ? ctx.formId : null);
        if (formKey) resetAppForm(formKey);
        else failures.push(tr('studio_apps_runtime.actions.failure_no_form', 'there is no form here to clear'));
    } else if (effects.refresh) {
        failures.push(tr('studio_apps_runtime.actions.failure_refresh_unknown', 'this app does not know how to refresh “{target}”', { target: String(effects.refresh) }));
    }
}

export async function applyEffects(effects: EffectObject | null | undefined, ctx: EffectContext, host: EffectHost): Promise<void> {
    const { tr } = host;
    // Reasons the return could not be carried out here, in the visitor's
    // words. Collected rather than thrown: a screen that no longer exists
    // must not swallow the toast that explains what just happened.
    const failures: string[] = [];

    // THE SERVER'S THIRD STATE. `_appEffectsUnknown` means: the run succeeded,
    // but the step read that `_appEffects` comes from fell over
    // (server/appStudio/actionExecutor/automationBridge.js). Without this line
    // that answer cannot be told apart from "this automation had no return
    // step": no toast, no navigation, no trace. This sits before the
    // `!effects` exit, because in exactly that case nothing else says it.
    if (ctx.effectsUnknown) {
        failures.push(tr('studio_apps_runtime.actions.failure_effects_unreadable', 'what the automation asked the app to do next could not be read'));
    }

    if (!effects || typeof effects !== 'object') {
        if (failures.length) reportEffectFailures(failures, null, tr);
        return;
    }
    warnUnknownKeys(effects);

    if (effects.toast && effects.toast.message) showToast(effects.toast.tone, effects.toast.message);

    applyNavigate(effects, host, failures);
    await applyRefresh(effects, ctx, host, failures);

    if (failures.length) reportEffectFailures(failures, effects.onError, tr);
}
