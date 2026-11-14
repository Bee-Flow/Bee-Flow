/**
 * modelTier on ai_generate / ai_extract: a tier name as written, or a binding
 * ({kind:'formula',expr} / {kind:'static',value}) worked out per run, so one
 * action can pick the quick model for a short text and the thinking one for a
 * long document.
 *
 * A binding that does not give a tier name falls back to the default tier, and
 * the step result says so in a note. A tier name from a formula is never logged
 * (aiRuntime.resolveOwnerModel's `fromBinding`).
 */

export type TierPick = {
    /** The tier to ask for; undefined = the default tier. */
    tier: string | undefined;
    /** The value came from a binding (not a tier name written in the step). */
    fromBinding: boolean;
    /** The binding gave no usable tier name. */
    invalid: boolean;
};

/** What resolveOwnerModel answered (the fields this module reads). */
export type ResolvedTier = { tierName?: unknown; askedTier?: unknown; fellBack?: unknown };

/** A tier name: what a tier map key or a `tier:` alias can look like. */
export const TIER_NAME_RE = /^[A-Za-z][A-Za-z0-9_:-]{0,59}$/;

const isBinding = (v: unknown): v is { kind: string } =>
    !!v && typeof v === 'object' && !Array.isArray(v) && ((v as { kind?: unknown }).kind === 'formula' || (v as { kind?: unknown }).kind === 'static');

/**
 * The tier a step asks for. `resolve` reads a binding against the step scope
 * (actionExecutor/shared.resolveBinding); a throw counts as "no tier name".
 */
export function pickModelTier(raw: unknown, resolve: (binding: unknown) => unknown): TierPick {
    if (raw === undefined || raw === null || raw === '') return { tier: undefined, fromBinding: false, invalid: false };
    if (typeof raw === 'string') return { tier: raw, fromBinding: false, invalid: false };
    if (!isBinding(raw)) return { tier: undefined, fromBinding: true, invalid: true };
    let value: unknown;
    try { value = resolve(raw); } catch { value = undefined; }
    const text = typeof value === 'string' ? value.trim() : '';
    if (!TIER_NAME_RE.test(text)) return { tier: undefined, fromBinding: true, invalid: true };
    return { tier: text, fromBinding: true, invalid: false };
}

/**
 * The note for the step result, or null. Only a BINDING gets one: a tier name
 * written in the step keeps today's behaviour (a log line, no note).
 */
export function modelTierNote(pick: TierPick, resolved: ResolvedTier | null | undefined): string | null {
    if (!pick.fromBinding) return null;
    if (pick.invalid) return 'The model tier formula did not give a tier name, so the default tier was used.';
    if (resolved && resolved.fellBack === true) {
        const used = typeof resolved.tierName === 'string' ? resolved.tierName : 'default';
        return `The model tier "${pick.tier}" is not set up in this workspace; "${used}" was used.`;
    }
    return null;
}

/** What the AI steps read of aiRuntime.resolveOwnerModel's answer (and pass on whole). */
type OwnerModel = ResolvedTier & Record<string, unknown>;
type ResolveOwnerModel<M extends OwnerModel> = (app: unknown, tier: string | undefined, opts?: { fromBinding?: boolean }) => Promise<M>;

/**
 * The owner's model for a step's modelTier (a tier name, or a binding worked out
 * now through `resolve`), plus the note when a binding gave no usable tier.
 * A tier from a binding is resolved with `fromBinding`, so it is never logged.
 * The answer keeps the runtime's own model type.
 */
export async function resolveStepModel<M extends OwnerModel>(aiRuntime: { resolveOwnerModel: ResolveOwnerModel<M> }, app: unknown, raw: unknown, resolve: (binding: unknown) => unknown): Promise<{ aiModel: M; tierNote: string | null }> {
    const pick = pickModelTier(raw, resolve);
    const aiModel = pick.fromBinding
        ? await aiRuntime.resolveOwnerModel(app, pick.tier, { fromBinding: true })
        : await aiRuntime.resolveOwnerModel(app, pick.tier);
    return { aiModel, tierNote: modelTierNote(pick, aiModel) };
}

/** The step's `notes` sibling, the tier note last; null when there are none (the old shape). */
export function notesWith(notes: string[], tierNote: string | null): { notes: string[] } | null {
    if (tierNote) notes.push(tierNote);
    return notes.length ? { notes } : null;
}
