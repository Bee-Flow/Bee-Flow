/**
 * Form draft -> the patch the inspector merges into the step. One writer per
 * step type, collected from the family modules next to this one; the label
 * and icon, the cross-cutting `retry` and the "only what changed" filter are
 * shared by every type and live here.
 */
import { PRIVACY_STEP_TYPES, readPrivacy, writePrivacy } from '../../../privacyModel';
import { ROUTE_STEP_TYPES, readRoute, writeRoute } from '../../../routeModel';
import { defaultTriggerLabel } from '../../../triggerLabels';
import { deepEqual } from '../primitives';
import { applyRetryPatch, RETRY_FORM_TYPES } from '../stepOptions';
import type { FormRecord, TypePatcher } from '../types';
import { actionPatchers } from './actions';
import { approvalPatchers } from './approval';
import { controlPatchers } from './control';
import { dataPatchers } from './data';
import { documentPatchers } from './documents';
import { triggerPatchers } from './trigger';

/** Step type -> its writer. A Map, so a type named like an Object key ('constructor') finds nothing. */
const TYPE_PATCHERS: ReadonlyMap<string, TypePatcher> = new Map(Object.entries({
    ...triggerPatchers,
    ...actionPatchers,
    ...documentPatchers,
    ...controlPatchers,
    ...approvalPatchers,
    ...dataPatchers,
}));

/** The type's own fields: route and privacy models first, then the per-type writer. */
function applyTypePatch(patch: FormRecord, step: FormRecord, draft: FormRecord): void {
    // If / Switch / Filter — one model, one writer. writeRoute also decides
    // WHICH runtime type expresses the model, so `patch.type` can change here
    // (the inspector's merge re-points the node's edges — flow/routeEdges.js).
    if (ROUTE_STEP_TYPES.has(step.type)) Object.assign(patch, writeRoute(draft.route || readRoute(step)));
    // Privacy Shield — same contract as the route model above: writePrivacy
    // picks the runtime type (guard / tokenize / untokenize) that expresses the
    // chosen mode, so `patch.type` can change here too. Keeping a second
    // writer for guard / tokenize / untokenize would fight it — the old one
    // rebuilt `onFound` from stop/mask alone and would strip the `tokenize`
    // action that makes a guard a Check + Hide step.
    if (PRIVACY_STEP_TYPES.has(step.type)) Object.assign(patch, writePrivacy(draft.privacy || readPrivacy(step)));
    TYPE_PATCHERS.get(step.type)?.(patch, step, draft);
}

/** The label and icon every type has, with their hand-set locks. */
function labelPatch(step: FormRecord, draft: FormRecord): FormRecord {
    const patch: FormRecord = { label: draft.label || null, icon: draft.icon || null };
    // Lock a field against AI auto-naming once the user sets it by hand. Only
    // touch the flag when the value actually changed in this edit, so re-saving
    // an AI-suggested value doesn't silently lock it. Clearing a field (empty)
    // unlocks it so the auto-namer can fill it again.
    if ((draft.label || '') !== (step.label || '')) patch.labelManual = draft.label ? true : null;
    if ((draft.icon || '') !== (step.icon || '')) patch.iconManual = draft.icon ? true : null;
    // …but a trigger label that is exactly the kind's generated name never
    // counts as hand-picked: the kind switcher writes it (BFSF-339), and
    // locking it there would freeze the node at whatever kind it passed
    // through and take it away from the AI auto-namer too.
    if (step.type === 'trigger' && draft.label && draft.label === defaultTriggerLabel(draft.kind || 'manual')) {
        patch.labelManual = null;
    }
    return patch;
}

export function buildPatch(step: FormRecord, draft: FormRecord): FormRecord {
    const patch = labelPatch(step, draft);
    applyTypePatch(patch, step, draft);
    if (RETRY_FORM_TYPES.has(step.type)) applyRetryPatch(patch, step, draft);
    // Send only the fields that ACTUALLY CHANGED vs the current step. The form
    // rebuilds every field for the step type on every save; sending all of
    // them would overwrite fields the user never touched — clobbering a
    // concurrent AI-builder edit to, say, the prompt while the user only
    // renamed the label. The *Manual flags are meta (not on the step) and are
    // only added when their value changed, so they're intentionally exempt.
    const META_KEYS = new Set(['labelManual', 'iconManual']);
    const changed: FormRecord = {};
    for (const k of Object.keys(patch)) {
        if (META_KEYS.has(k)) { changed[k] = patch[k]; continue; }
        if (!deepEqual(patch[k], step[k])) changed[k] = patch[k];
    }
    return changed;
}
