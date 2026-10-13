/**
 * buildPatch for the steps that shape the run itself: loops, flowlets and
 * blocks, waits, stops, the return to an app and hosted form pages.
 */
import { sanitizeFieldMap, sanitizeInputs } from '../bindings';
import { clamp } from '../primitives';
import type { TypePatcher } from '../types';

export const controlPatchers: Record<string, TypePatcher> = {
    loop: (patch, step, draft) => {
        patch.overRef = draft.overRef || '';
        // Never persist '' — the inspector displays 'item' as the effective
        // value, so persist exactly that (C9).
        patch.itemVar = String(draft.itemVar || '').trim() || 'item';
        patch.maxIterations = clamp(Number(draft.maxIterations) || 100, 1, 1000);
        patch.batchSize = clamp(Number(draft.batchSize) || 1, 1, 1000);
        patch.body = Array.isArray(draft.body) ? draft.body : [];
    },
    // Flowlets
    call_layer: (patch, step, draft) => {
        patch.inputs = sanitizeInputs(draft.inputs || {});
    },
    call_block: (patch, step, draft) => {
        patch.inputs = sanitizeInputs(draft.inputs || {});
    },
    layer_output: (patch, step, draft) => {
        patch.fields = sanitizeFieldMap(draft.fields || {});
    },
    wait: (patch, step, draft) => { patch.seconds = clamp(Number(draft.seconds) || 1, 1, 86400); },
    stop_error: (patch, step, draft) => { patch.message = draft.message || ''; },
    return_to_app: (patch, step, draft) => {
        // An empty field means "don't do this", and that is `null` — not an
        // empty object. `{ screenId: '' }` would make the validator miss a
        // screen (`return_to_app.screen_missing`) while the author said
        // precisely that no navigation is needed.
        const screenId = String(draft.navigateScreenId || '').trim();
        const recordRef = String(draft.navigateRecordRef || '').trim();
        patch.navigateTo = screenId ? { screenId, ...(recordRef ? { recordRef } : {}) } : null;
        const toastMessage = String(draft.toastMessage || '').trim();
        patch.toast = toastMessage ? { message: toastMessage, tone: draft.toastTone || 'info' } : null;
        patch.refresh = draft.refresh || null;
        patch.onError = draft.onError === 'errorScreen' ? 'errorScreen' : 'stay';
    },
    form_page: (patch, step, draft) => {
        const ending = draft.mode === 'ending';
        patch.mode = ending ? 'ending' : 'input';
        patch.form = draft.form || null;
        // Clamps must match the server's (validate.js FORM_PAGE_MIN/MAX_WAIT_S
        // and builderTools' normalizePatchField), or a UI-built step and an
        // AI-built one would disagree. An ending page never waits.
        patch.waitSeconds = ending ? null : clamp(Number(draft.waitSeconds) || 3600, 60, 7 * 24 * 3600);
    },
};
