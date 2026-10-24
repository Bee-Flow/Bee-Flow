/**
 * Pure helpers for the "preserve & patch" refine flow. No React — unit-testable
 * in isolation.
 *
 *   buildRefineContext(state) → { plan, current }
 *     The request payload the editor sends to POST /agents/wizard/refine. `plan`
 *     is the editable text surface the AI rewrites — including the four
 *     descriptive `persona` fields, so a refine can patch the role instead of
 *     re-inventing it; `current` is the curated configuration the server is
 *     told to preserve.
 *
 *   personaFieldsOf(persona) → { who, tone, does, doesNot } | null
 *   hasFreeInstruction(state) → boolean
 *     The two questions the persona half of the merge turns on. See each.
 *
 *   diffRefinedPlan(before, after) → changes[]
 *     Wat de verfijning FEITELIJK veranderde: de diff tussen de staat vóór de
 *     merge en de snapshot die eruit kwam. Zie de docblock bij de functie.
 *
 *   mergeRefinedPlan(current, updated, preserved, opts) → { name, description,
 *     systemPrompt, avatar, model, config, persona }
 *     Deterministically folds the AI's plan into the agent's current state so a
 *     tone-only refine NEVER wipes curated apps/skills/model/KBs.
 *
 * Golden rule: absent/empty field ⇒ keep current. Curated collections
 * (apps, skills, knowledge bases) are additive on refine — refine can add to
 * them but never silently empties them; removals are done manually in the editor.
 */
import type {
    FullRefineSnapshot, MergedRefinePlan, MergeOpts, PersonaFields, PersonaLike, RefineChange, RefineConfig, RefinePlan,
    RefinePreserved, RefineSnapshot, RefineState,
} from './refineMerge.types';
import type { Persona } from '../role/personaFacts';

/**
 * The four DESCRIBING persona fields of a persona object, or `null`.
 *
 * This is the shape that has to travel with the plan: outward (so a refinement can keep
 * the role that is there instead of inventing it anew) and back (the model fills them
 * in). `unknown`, `language`, `mode` and `freeText` NEVER travel. `unknown` has
 * consequences in the config (strict knowledge, an app, an automation grant), and
 * `language`/`mode`/`freeText` belong to the editor, not to the model. A plan is a
 * proposal, not a grant.
 *
 * `null` means "no role here", and that is a real answer: the callers fall back on the
 * prose text as the source then.
 */
export function personaFieldsOf(persona: PersonaLike | null | undefined): PersonaFields | null {
    if (!persona || typeof persona !== 'object' || Array.isArray(persona)) return null;
    const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
    const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
    const tone: Partial<Persona['tone']> = persona.tone && typeof persona.tone === 'object' ? persona.tone : {};
    const fields = {
        who: str(persona.who),
        tone: { chips: list(tone.chips), text: str(tone.text) },
        does: list(persona.does),
        doesNot: list(persona.doesNot),
    };
    const hasContent = !!(fields.who || fields.does.length || fields.doesNot.length
        || fields.tone.chips.length || fields.tone.text);
    return hasContent ? fields : null;
}

/**
 * Does this agent ALREADY have a free instruction? That is text that someone wrote
 * himself and that is the source of its behaviour.
 *
 * The question decides whether the wizard may put the FIRST version into the fields.
 * There are two sources, and the narrow reading wins:
 *
 *   - if the persona is in `fields` mode, there is by definition no free instruction
 *     (`freeText` is not kept in that mode). The prompt the editor shows is then the
 *     RENDERING of those fields, not text of its own;
 *   - otherwise every non-empty `freeText` AND every non-empty `systemPrompt` counts.
 *
 * `systemPrompt` is deliberately the decisive fallback for an agent whose persona we do
 * not know (the column was not read, or it did not yet exist when the agent was made):
 * `agents.system_prompt` IS the rendering of the persona, so an agent with an empty
 * prompt has nothing to lose, and an agent with text in it does, even if we cannot see
 * where that text comes from.
 */
export function hasFreeInstruction(state: { persona?: PersonaLike | null; systemPrompt?: string } = {}): boolean {
    const persona = state.persona;
    if (persona && typeof persona === 'object' && persona.mode === 'fields') return false;
    const freeText = persona && typeof persona === 'object' && typeof persona.freeText === 'string'
        ? persona.freeText : '';
    return !!(freeText.trim() || String(state.systemPrompt || '').trim());
}

/** Build the { plan, current } portions of the refine request from live state. */
export function buildRefineContext(state: RefineState = {}) {
    const {
        name, description, avatar, systemPrompt, capabilities,
        model, enabledIntegrations, attachedSkills, knowledge_base_ids, persona,
    } = state;
    const personaFields = personaFieldsOf(persona);
    return {
        plan: {
            name: name || '',
            description: description || '',
            avatar: avatar || '',
            systemPrompt: systemPrompt || '',
            capabilities: Array.isArray(capabilities) ? capabilities : [],
            // Only send it along if there really is a role. An empty block would tell the model
            // that this agent has one that is empty, and then "keep unless asked otherwise" is
            // an instruction to write nothing.
            ...(personaFields ? { persona: personaFields } : {}),
        },
        current: {
            // Full model string (e.g. "tier:thinking" / a custom tier) — the
            // server echoes it back verbatim in `preserved.model`.
            model: typeof model === 'string' ? model : null,
            enabledIntegrations: Array.isArray(enabledIntegrations) ? enabledIntegrations : [],
            // [{ id, name }] so the model can reuse skills by id.
            attachedSkills: Array.isArray(attachedSkills) ? attachedSkills : [],
            knowledge_base_ids: Array.isArray(knowledge_base_ids) ? knowledge_base_ids : [],
        },
    };
}

const uniq = <T,>(arr: T[] | null | undefined): T[] => Array.from(new Set((arr || []).filter(Boolean)));

/**
 * The persona (A1c) after a refine.
 *
 * Persona is the SOURCE of the system prompt on the server, so the two may never drift:
 * a refine that rewrites the prompt and leaves the persona untouched leaves the fields
 * describing instructions the agent no longer has, and the next save would render the
 * OLD fields straight back over the new prompt.
 *
 * Three cases now, and the golden rule ("absent means keep") decides the first two:
 *
 *   the prompt did NOT change → keep the current persona verbatim, including
 *   `undefined` (the PUT then omits the field and the server preserves the column).
 *   A tone-only refine must not rewrite a persona the user built by hand.
 *
 *   the prompt DID change on an agent that ALREADY HAS A FREE INSTRUCTION → free mode
 *   over the refined prompt, exactly as before. This is the guard that matters: someone
 *   who writes their own instructions must never find them replaced by five fields
 *   because a refine ran. Their text stays the source; the fields keep describing it.
 *
 *   the prompt DID change on an agent WITHOUT one (the wizard's first version out of
 *   one sentence) → the FIELDS become the source (A3). This is the whole point of the
 *   Role tab: five cards you can edit. An agent born in free mode opens them read-only,
 *   and since the wizard is how nearly every agent is born, that would make Role a
 *   read-only screen for the whole product. Nothing is thrown away doing it, because the
 *   fields are no longer guessed from `description` + `capabilities`: the plan schema
 *   asks the model for `who`/`tone`/`does`/`doesNot`, and this writes what it wrote.
 *   When the plan carries no role (an older server, a model that skipped the block)
 *   there is nothing to be the source, so free mode is what happens.
 *
 * Either way, the SETTINGS that a refine says nothing about ("when you do not know",
 * language) are carried over rather than reset. The server re-normalises all of it; this
 * only has to be honest.
 *
 * ── AN UNREADABLE PERSONA DOES NOT WRITE ───────────────────────────────────
 *
 * `undefined` in the column here means "not read", not "empty": the list route STRIPS
 * `persona` (`agentCrud._stripPersona`), so everything hangs on the extra
 * `GET /agents/:id?draft=1`, and that can 403 or fail. On such an answer this function
 * used to build a FRESH persona in free mode, over an agent that may have
 * `{mode:'fields', unknown:{mode:'handoff', automationId:'auto-1'}, language:'nl'}` in
 * the column. This code never read those two settings and would therefore throw them
 * away; the server would then fill them in with 'honest'/null. The hand-off automation
 * and the language rule were silently gone, and the five role cards read-only. Unknown
 * narrows to `undefined`: the PUT then omits the field and the column stays.
 *
 * ── A REFINEMENT MAY ALSO REMOVE SOMETHING ────────────────────────────────
 *
 * "Absent/empty means keep" was harmless when the prompt was the source. Now that the
 * FIELDS are the source, it meant that a refinement could not REMOVE a rule: the model
 * neatly removes "never promise a refund" from `doesNot` and from the prompt, the Done
 * card ("Gedaan") reports changed instructions, and the server renders the rule back
 * into the prompt from the stored `doesNot`. So: if the plan carries a role block, then
 * `does`, `doesNot` and `tone` come from that block, empty included. If it carries none
 * (an older server, a model that skipped the block), "keep" still applies, because then
 * nothing was said.
 *
 * `who` is the exception and still falls back. It is one field, a model that leaves it
 * empty has almost always skipped it, and an empty `who` over a filled one is not what
 * "adjusting" means.
 */
function personaAfterRefine(current: RefineSnapshot, { systemPrompt, description, capabilities, planPersona }: {
    systemPrompt: string | undefined;
    description: string | undefined;
    capabilities: string[];
    planPersona: PersonaLike | null | undefined;
}): PersonaLike | null | undefined {
    const cur = current.persona;
    if (systemPrompt === current.systemPrompt) return cur;
    const readable = !!cur && typeof cur === 'object' && !Array.isArray(cur);
    // UNKNOWN DOES NOT WRITE, and `noStoredPersona` is the only exception.
    // That flag says there is not yet a ROW (the wizard only creates it on the first save),
    // so there is no column to protect, and this IS the first version. The flag is off by
    // default: whoever forgets it gets the narrow outcome, not the destructive one.
    if (!readable && current.noStoredPersona !== true) return undefined;
    const base: PersonaLike = readable ? cur : {};
    const fields = personaFieldsOf(planPersona);
    const described = fields
        ? {
            ...base,
            who: fields.who || base.who || '',
            does: fields.does,
            doesNot: fields.doesNot,
            tone: fields.tone,
        }
        : {
            ...base,
            who: description || base.who || '',
            does: (Array.isArray(capabilities) && capabilities.length ? capabilities : (base.does || [])),
        };
    if (fields && !hasFreeInstruction(current)) {
        // Fields mode drops freeText on the server; sending '' says the same
        // thing here, so nothing downstream reads a stale second copy.
        return { ...described, mode: 'fields', freeText: '' };
    }
    return { ...described, mode: 'free', freeText: systemPrompt || '' };
}

/**
 * `current.persona` is what is in the column. Unreadable or absent means "not read" and
 * leaves the column alone. `noStoredPersona: true` is the only answer that says there is
 * no row yet; see personaAfterRefine. `updated` is the normalized AI plan, `preserved`
 * the server's echo of the current curated config.
 */
export function mergeRefinedPlan(current: FullRefineSnapshot, updated?: RefinePlan, preserved?: RefinePreserved, opts?: MergeOpts): MergedRefinePlan<string>;
export function mergeRefinedPlan(current?: RefineSnapshot, updated?: RefinePlan, preserved?: RefinePreserved, opts?: MergeOpts): MergedRefinePlan;
export function mergeRefinedPlan(current: RefineSnapshot = {}, updated: RefinePlan = {}, preserved: RefinePreserved = {}, opts: MergeOpts = {}): MergedRefinePlan {
    const {
        availableIntegrationIds = [],
        selectableTierKeys = [],
        resolvedSkillIds = null, // caller's already-unioned skill ids (current ∪ reused ∪ created)
    } = opts;
    const curConfig: RefineConfig = current.config || {};

    // ── name / avatar — take the AI value only when it provided a real one ──
    const name = (typeof updated.name === 'string' && updated.name.trim()) ? updated.name : current.name;
    const avatar = updated.avatar || current.avatar;

    // ── description / systemPrompt — the patch targets ──
    const description = (typeof updated.description === 'string') ? updated.description : current.description;
    const systemPrompt = (typeof updated.systemPrompt === 'string' && updated.systemPrompt.trim())
        ? updated.systemPrompt
        : current.systemPrompt;

    // ── model — apply the AI's tier ONLY if it maps to a real, selectable tier;
    // otherwise keep the current tier. Never blank the model. (preserved.model
    // already equals current.model.) ──
    let model = current.model;
    if (typeof updated.model === 'string' && updated.model) {
        const tierName = updated.model === 'smart' ? 'thinking' : updated.model;
        if (selectableTierKeys.includes(tierName)) model = `tier:${tierName}`;
    }

    // ── enabledIntegrations — replace only with a NON-EMPTY AI array (handles
    // add & remove intent); an empty/absent array means "AI didn't touch apps"
    // → preserve. This is what stops a tone refine from wiping curated apps. ──
    const curApps = Array.isArray(preserved.enabledIntegrations) && preserved.enabledIntegrations.length
        ? preserved.enabledIntegrations
        : (Array.isArray(curConfig.enabledIntegrations) ? curConfig.enabledIntegrations : []);
    let enabledIntegrations = curApps;
    if (Array.isArray(updated.enabledIntegrations) && updated.enabledIntegrations.length) {
        enabledIntegrations = updated.enabledIntegrations.filter(id => availableIntegrationIds.includes(id));
    }

    // ── skills — UNION, never subtract. resolvedSkillIds is the caller's fully
    // resolved set; fall back to current when the refine touched no skills. ──
    const attachedSkillIds = Array.isArray(resolvedSkillIds)
        ? uniq(resolvedSkillIds)
        : (Array.isArray(curConfig.attachedSkillIds) ? curConfig.attachedSkillIds : []);

    // ── knowledge_base_ids — replace only with a NON-EMPTY AI array; else
    // preserve (refines almost never edit KBs and the model often omits them). ──
    const curKbs = Array.isArray(preserved.knowledge_base_ids) && preserved.knowledge_base_ids.length
        ? preserved.knowledge_base_ids
        : (Array.isArray(curConfig.knowledge_base_ids) ? curConfig.knowledge_base_ids : []);
    let knowledge_base_ids = curKbs;
    if (Array.isArray(updated.knowledge_base_ids) && updated.knowledge_base_ids.length) {
        knowledge_base_ids = updated.knowledge_base_ids;
    }

    const config = {
        ...curConfig,
        enabledIntegrations,
        attachedSkillIds,
        knowledge_base_ids,
        wizard: {
            ...(curConfig.wizard || {}),
            capabilities: Array.isArray(updated.capabilities) ? updated.capabilities : (curConfig.wizard?.capabilities || []),
        },
    };

    const persona = personaAfterRefine(current, {
        systemPrompt,
        description,
        capabilities: config.wizard.capabilities,
        planPersona: updated.persona,
    });

    return { name, description, systemPrompt, avatar, model, config, persona };
}

/**
 * The diff between the state BEFORE the merge and the snapshot that mergeRefinedPlan
 * returned: the "Gedaan: …" turn ("Done: …") in the refine rail.
 *
 * Why here and not on the server: the server does not compute the merge. Its answer is a
 * PLAN plus an echo of the stored config. Which fields actually change is decided here by
 * `mergeRefinedPlan`, with its preserve rules ("empty means keep", "skills are a union
 * only"). A changes[] from the server would tell what the model wanted, not what
 * happened, and precisely that difference is what the user has to read.
 *
 * The shape is deliberately DATA, not a sentence: `{ field, direction?, count?, ids? }`.
 * The rail picks its key for it (singular/plural), so the translation stays a choice of
 * key and not glued-together English grammar.
 *
 * What is NOT in it: `persona` (which follows the instructions by definition; naming it
 * separately would report the same change twice) and `wizard.capabilities` (internal;
 * the user sees no field for it).
 */
export function diffRefinedPlan(before: RefineSnapshot = {}, after: RefineSnapshot = {}): RefineChange[] {
    const changes: RefineChange[] = [];
    const text = (v: unknown): string => (typeof v === 'string' ? v : (v == null ? '' : String(v)));
    for (const field of ['systemPrompt', 'name', 'description', 'avatar', 'model'] as const) {
        if (text(before[field]) !== text(after[field])) changes.push({ field });
    }
    const beforeCfg = before.config || {};
    const afterCfg = after.config || {};
    for (const [field, key] of [
        ['apps', 'enabledIntegrations'],
        ['skills', 'attachedSkillIds'],
        ['knowledge', 'knowledge_base_ids'],
    ] as const) {
        const was = Array.isArray(beforeCfg[key]) ? beforeCfg[key] : [];
        const now = Array.isArray(afterCfg[key]) ? afterCfg[key] : [];
        const added = now.filter(id => !was.includes(id));
        const removed = was.filter(id => !now.includes(id));
        if (added.length) changes.push({ field, direction: 'added', count: added.length, ids: added });
        if (removed.length) changes.push({ field, direction: 'removed', count: removed.length, ids: removed });

    }
    return changes;
}
