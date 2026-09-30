/**
 * The unified "Privacy Shield" node: Check / Check + Hide / Hide / Reveal are
 * ONE editor over the three runtime types `guard`, `tokenize`, `untokenize`.
 * Port of the model half of agent-hub `Builder/flow/privacyModel.js` — the mode
 * words live with the editor that shows them. Pinned by flowDeps.lockstep.test.ts.
 */

import { isObj } from '../json';
import type { FlowNode } from '../types';

export const PRIVACY_STEP_TYPES: ReadonlySet<string> = new Set(['guard', 'tokenize', 'untokenize']);

export type PrivacyMode = 'check' | 'check_hide' | 'hide' | 'reveal';

/** Mode → the runtime step type it is stored as, in the web's order. */
export const PRIVACY_MODE_TYPES: readonly (readonly [PrivacyMode, string])[] = [
    ['check', 'guard'],
    ['check_hide', 'guard'],
    ['hide', 'tokenize'],
    ['reveal', 'untokenize'],
];

const MODE_TYPE = new Map<string, string>(PRIVACY_MODE_TYPES);

export interface PrivacyModel {
    mode: PrivacyMode;
    sourceRef: string;
    categories: unknown[] | null;
    confidence: number | null;
    stopOnFound: boolean;
    maskOnFound: boolean;
}

type StepLike = Partial<FlowNode> | null | undefined;

export function isPrivacyStep(step: StepLike): boolean {
    return !!step && PRIVACY_STEP_TYPES.has(String(step.type));
}

export function stepTypeForMode(mode: unknown): string {
    return (typeof mode === 'string' && MODE_TYPE.get(mode)) || 'guard';
}

export function modeScans(mode: unknown): boolean {
    return mode === 'check' || mode === 'check_hide' || mode === 'hide';
}

/** Only the two guard-backed modes have two ports. */
export function modeBranches(mode: unknown): boolean {
    return mode === 'check' || mode === 'check_hide';
}

export function modeHides(mode: unknown): boolean {
    return mode === 'hide' || mode === 'check_hide';
}

function onFoundOf(step: StepLike): Record<string, unknown> {
    return isObj(step?.onFound) ? step.onFound : {};
}

/** Persisted step → the mode it is edited as; anything unknown reads 'check'. */
export function readPrivacyMode(step: StepLike): PrivacyMode {
    if (step?.type === 'tokenize') return 'hide';
    if (step?.type === 'untokenize') return 'reveal';
    return onFoundOf(step).tokenize ? 'check_hide' : 'check';
}

/** Persisted step → the unified model. Absent categories/confidence stay null (inherit the org). */
export function readPrivacy(step: StepLike): PrivacyModel {
    const onFound = onFoundOf(step);
    return {
        mode: readPrivacyMode(step),
        sourceRef: (step?.sourceRef as string) || '',
        categories: Array.isArray(step?.categories) ? step.categories : null,
        confidence: typeof step?.confidence === 'number' ? step.confidence : null,
        stopOnFound: !!onFound.stop,
        maskOnFound: !!onFound.mask,
    };
}

/** The unified model → a step patch; keys the mode doesn't carry are `undefined`. */
function privacyBase(mode: PrivacyMode, model: Partial<PrivacyModel>): Record<string, unknown> {
    return {
        type: stepTypeForMode(mode),
        sourceRef: model.sourceRef || '',
        categories: Array.isArray(model.categories) && model.categories.length ? model.categories : undefined,
        confidence: typeof model.confidence === 'number' ? model.confidence : undefined,
    };
}

export function writePrivacy(input: Partial<PrivacyModel> | null | undefined): Record<string, unknown> {
    const model = input || {};
    const mode = typeof model.mode === 'string' && MODE_TYPE.has(model.mode) ? model.mode : 'check';
    const base = privacyBase(mode, model);
    if (!modeBranches(mode)) return { ...base, onFound: undefined };
    const onFound: Record<string, boolean> = {};
    if (model.stopOnFound) onFound.stop = true;
    if (model.maskOnFound) onFound.mask = true;
    if (mode === 'check_hide') onFound.tokenize = true;
    return { ...base, onFound: Object.keys(onFound).length ? onFound : undefined };
}
