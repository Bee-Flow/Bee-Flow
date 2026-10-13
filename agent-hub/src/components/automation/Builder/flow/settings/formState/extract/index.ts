/**
 * Stored step -> form draft. One extractor per step type, collected from the
 * family modules next to this one; the cross-cutting `retry` is added here,
 * once, for every type that offers it.
 */
import { PRIVACY_STEP_TYPES, readPrivacy } from '../../../privacyModel';
import { ROUTE_STEP_TYPES, readRoute } from '../../../routeModel';
import { defaultTriggerLabel } from '../../../triggerLabels';
import { normalizeRetry, RETRY_FORM_TYPES } from '../stepOptions';
import type { FormBase, FormRecord, TypeExtractor } from '../types';
import { actionExtractors } from './actions';
import { approvalExtractors } from './approval';
import { controlExtractors } from './control';
import { dataExtractors } from './data';
import { documentExtractors } from './documents';
import { triggerExtractors } from './trigger';

/** Step type -> its extractor. A Map, so a type named like an Object key ('constructor') finds nothing. */
const TYPE_EXTRACTORS: ReadonlyMap<string, TypeExtractor> = new Map(Object.entries({
    ...triggerExtractors,
    ...actionExtractors,
    ...documentExtractors,
    ...controlExtractors,
    ...approvalExtractors,
    ...dataExtractors,
}));

export function defaultLabelPlaceholder(step: FormRecord): string {
    if (step.type === 'integration_action') return step.tool || step.type;
    if (step.type === 'trigger') return defaultTriggerLabel(step.kind || 'manual');
    return step.type;
}

/**
 * The per-type branches. Everything that is NOT per-type — today just
 * `retry` — is added by extractFormState below, so a cross-cutting field is
 * added once instead of being pasted into eighteen object literals and
 * forgotten in five of them. That is how the loop toggle ended up shipped on
 * one step type and missing on five (C12/C16/C18).
 */
function extractTypeFormState(step: FormRecord | null | undefined): FormRecord {
    if (!step) return {};
    const base: FormBase = { label: step.label || '', icon: step.icon || '' };
    // If / Switch / Filter are ONE node in the editor (see flow/routeModel.js):
    // the form edits a single `route` model and picks the runtime type that
    // expresses it, so all three share this branch.
    if (ROUTE_STEP_TYPES.has(step.type)) return { ...base, route: readRoute(step) };
    // Check / Hide / Check + Hide / Reveal are ONE node too (flow/privacyModel.js),
    // same shape of translation: one `privacy` model over three runtime types.
    // `categories` and `confidence` stay absent when unset there too:
    // undefined means "inherit the org's Privacy Shield", and defaulting them
    // would freeze today's policy into the step and silently stop following
    // the organisation.
    if (PRIVACY_STEP_TYPES.has(step.type)) return { ...base, privacy: readPrivacy(step) };
    const extract = TYPE_EXTRACTORS.get(step.type);
    return extract ? extract(step, base) : base;
}

/**
 * Translate the form draft back into the persisted-step shape. We only
 * include keys that this form actually edits — everything else (id,
 * outputSchema, side-effect flag, etc.) is preserved by the inspector's
 * patch-merge.
 */
export function extractFormState(step: FormRecord | null | undefined): FormRecord {
    const state = extractTypeFormState(step);
    // Present as a KEY even when unset, because that presence is what the
    // editor reads to decide whether the row may be offered at all (see
    // RetrySection). `null` is off; `{ max: 0 }` is the runner's own off and
    // reads the same, without being rewritten on the way through.
    if (step && RETRY_FORM_TYPES.has(step.type)) state.retry = normalizeRetry(step.retry) || null;
    return state;
}
