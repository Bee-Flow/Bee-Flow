/**
 * Drafts and patches for the steps that call out: an app action, code, a
 * notification, an HTTP request. From agent-hub
 * `Builder/flow/settings/formState.js`; pinned by formState.lockstep.test.ts.
 */

import {
    applyAskOncePatch, applyCacheIntoPatch, applyForEachPatch, normalizeAskOnce, normalizeCacheInto, sanitizeInputs,
} from './common';
import { arrOr, clamp, get, num, objOr, or } from './read';
import type { Extractor, FormDraft, Patcher } from './types';

export const extractIntegration: Extractor = (step, base) => ({
    ...base,
    tool: or(step.tool, ''),
    appId: or(step.appId, null),
    sideEffect: step.sideEffect ?? null,
    inputs: or(step.inputs, {}),
    forEach: or(step.forEach, null),
    askOnce: normalizeAskOnce(step.askOnce),
});

export const patchIntegration: Patcher = (patch, step, draft) => {
    patch.inputs = sanitizeInputs(or(draft.inputs, {}));
    // The tool can change in place (the operation switcher): always sent.
    patch.tool = draft.tool || step.tool || '';
    if (draft.appId || step.appId) patch.appId = draft.appId || step.appId;
    if (draft.sideEffect != null) patch.sideEffect = draft.sideEffect;
    applyForEachPatch(patch, step, draft);
    applyAskOncePatch(patch, step, draft);
};

// `inputs` ride along: the runner resolves them before the isolate exists.
export const extractCode: Extractor = (step, base) => ({
    ...base,
    code: or(step.code, ''),
    inputs: or(step.inputs, {}),
    allowedHosts: arrOr(step.allowedHosts, []),
    forEach: or(step.forEach, null),
});

export const patchCode: Patcher = (patch, step, draft) => {
    patch.code = or(draft.code, '');
    patch.inputs = sanitizeInputs(or(draft.inputs, {}));
    // Where ctx.http may go besides the hosts the code names (the runner's host list).
    const hosts = (Array.isArray(draft.allowedHosts) ? draft.allowedHosts : []).filter((h) => typeof h === 'string' && h.trim());
    if (hosts.length || Array.isArray(step.allowedHosts)) patch.allowedHosts = hosts;
    applyForEachPatch(patch, step, draft);
};

export const extractNotification: Extractor = (step, base) => ({
    ...base,
    title: or(step.title, ''),
    body: or(step.body, ''),
    channels: arrOr(step.channels, null),
    forEach: or(step.forEach, null),
});

export const patchNotification: Patcher = (patch, step, draft) => {
    patch.title = or(draft.title, '');
    patch.body = or(draft.body, '');
    // Omitted when untouched: the runner reads a missing `channels` as the bell.
    if (Array.isArray(draft.channels)) patch.channels = draft.channels;
    applyForEachPatch(patch, step, draft);
};

/** Only the opaque connection reference lives in the definition. */
function authRef(auth: unknown): { connectionId: unknown } | null {
    const id = get(auth, 'connectionId');
    return auth && typeof auth === 'object' && id ? { connectionId: id } : null;
}

export const extractHttp: Extractor = (step, base): FormDraft => ({
    ...base,
    url: or(step.url, ''),
    method: or(step.method, 'GET'),
    headers: objOr(step.headers, {}),
    body: or(step.body, ''),
    timeoutMs: num(step.timeoutMs, 10_000),
    blockPrivateTargets: step.blockPrivateTargets !== false,
    parseResponse: or(step.parseResponse, 'auto'),
    forEach: or(step.forEach, null),
    auth: authRef(step.auth),
    askOnce: normalizeAskOnce(step.askOnce),
    cacheInto: normalizeCacheInto(step.cacheInto),
});

export const patchHttp: Patcher = (patch, step, draft) => {
    patch.url = or(draft.url, '');
    patch.method = String(or(draft.method, 'GET')).toUpperCase();
    patch.headers = objOr(draft.headers, {});
    patch.body = or(draft.body, '');
    patch.timeoutMs = clamp(Number(draft.timeoutMs) || 10_000, 1000, 60_000);
    patch.blockPrivateTargets = draft.blockPrivateTargets !== false;
    // 'auto' is the default and is stored as absence.
    patch.parseResponse = ['never', 'always'].includes(draft.parseResponse as string) ? draft.parseResponse : undefined;
    patch.auth = get(draft.auth, 'connectionId') ? { connectionId: get(draft.auth, 'connectionId') } : null;
    applyForEachPatch(patch, step, draft);
    applyAskOncePatch(patch, step, draft);
    applyCacheIntoPatch(patch, step, draft);
};
