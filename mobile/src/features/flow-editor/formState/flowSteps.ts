/**
 * Drafts and patches for the steps that shape the flow: the unified Condition
 * (If / Switch / Filter, one `route` model) and Privacy Shield (one `privacy`
 * model) — whose writers pick the runtime TYPE, so `patch.type` can change —
 * plus loop, flowlet calls and returns, wait, stop, return-to-app and form
 * pages. From agent-hub `Builder/flow/settings/formState.js`; pinned by
 * formState.lockstep.test.ts.
 */

import { sanitizeFieldMap, sanitizeInputs } from './common';
import { clamp, get, num, objOr, or } from './read';
import type { Extractor, Patcher } from './types';
import { readPrivacy, writePrivacy, type PrivacyModel } from '../bindings/flowDeps/privacyModel';
import { readRoute, writeRoute, type Route } from '../model/route/routeModel';

export const extractRoute: Extractor = (step, base) => ({ ...base, route: readRoute(step) });

export const patchRoute: Patcher = (patch, step, draft) => {
    Object.assign(patch, writeRoute((draft.route as Partial<Route>) || readRoute(step)));
};

export const extractPrivacy: Extractor = (step, base) => ({ ...base, privacy: readPrivacy(step) });

export const patchPrivacy: Patcher = (patch, step, draft) => {
    Object.assign(patch, writePrivacy((draft.privacy as Partial<PrivacyModel>) || readPrivacy(step)));
};

export const extractLoop: Extractor = (step, base) => ({
    ...base,
    overRef: or(step.overRef, ''),
    // Display truth == persisted truth (C9): an absent itemVar shows AND saves 'item'.
    itemVar: or(step.itemVar, 'item'),
    maxIterations: step.maxIterations ?? 100,
    batchSize: step.batchSize ?? 1,
    body: Array.isArray(step.body) ? step.body : [],
});

export const patchLoop: Patcher = (patch, _step, draft) => {
    patch.overRef = or(draft.overRef, '');
    patch.itemVar = String(draft.itemVar || '').trim() || 'item';
    patch.maxIterations = clamp(Number(draft.maxIterations) || 100, 1, 1000);
    patch.batchSize = clamp(Number(draft.batchSize) || 1, 1, 1000);
    patch.body = Array.isArray(draft.body) ? draft.body : [];
};

/** Flowlet and Step calls: the contract comes from elsewhere, only `inputs` are the step's. */
export const extractCallInputs: Extractor = (step, base) => ({ ...base, inputs: or(step.inputs, {}) });

export const patchCallInputs: Patcher = (patch, _step, draft) => {
    patch.inputs = sanitizeInputs(or(draft.inputs, {}));
};

export const extractLayerOutput: Extractor = (step, base) => ({ ...base, fields: or(step.fields, {}) });

export const patchLayerOutput: Patcher = (patch, _step, draft) => {
    patch.fields = sanitizeFieldMap(or(draft.fields, {}));
};

export const extractWait: Extractor = (step, base) => ({ ...base, seconds: num(step.seconds, 5) });

export const patchWait: Patcher = (patch, _step, draft) => {
    patch.seconds = clamp(Number(draft.seconds) || 1, 1, 86400);
};

export const extractStopError: Extractor = (step, base) => ({ ...base, message: or(step.message, '') });

export const patchStopError: Patcher = (patch, _step, draft) => {
    patch.message = or(draft.message, '');
};

/** Flattened so each form field owns one key; the patch re-nests them. */
export const extractReturnToApp: Extractor = (step, base) => ({
    ...base,
    navigateScreenId: or(get(step.navigateTo, 'screenId'), ''),
    navigateRecordRef: or(get(step.navigateTo, 'recordRef'), ''),
    toastMessage: or(get(step.toast, 'message'), ''),
    toastTone: or(get(step.toast, 'tone'), 'info'),
    refresh: or(step.refresh, ''),
    // Absent narrows to 'stay' — the runner's own answer for an empty field.
    onError: step.onError === 'errorScreen' ? 'errorScreen' : 'stay',
});

/** An empty field means "don't", which is null — never `{ screenId: '' }`. */
export const patchReturnToApp: Patcher = (patch, _step, draft) => {
    const screenId = String(draft.navigateScreenId || '').trim();
    const recordRef = String(draft.navigateRecordRef || '').trim();
    patch.navigateTo = screenId ? { screenId, ...(recordRef ? { recordRef } : {}) } : null;
    const toastMessage = String(draft.toastMessage || '').trim();
    patch.toast = toastMessage ? { message: toastMessage, tone: draft.toastTone || 'info' } : null;
    patch.refresh = draft.refresh || null;
    patch.onError = draft.onError === 'errorScreen' ? 'errorScreen' : 'stay';
};

export const extractFormPage: Extractor = (step, base) => ({
    ...base,
    mode: step.mode === 'ending' ? 'ending' : 'input',
    // `null` inside the declaration is meaningful (theme: null = inherit).
    form: objOr(step.form, null),
    waitSeconds: num(step.waitSeconds, 3600),
});

/** Clamps match validate.js FORM_PAGE_MIN/MAX_WAIT_S; an ending page never waits. */
export const patchFormPage: Patcher = (patch, _step, draft) => {
    const ending = draft.mode === 'ending';
    patch.mode = ending ? 'ending' : 'input';
    patch.form = draft.form || null;
    patch.waitSeconds = ending ? null : clamp(Number(draft.waitSeconds) || 3600, 60, 7 * 24 * 3600);
};
