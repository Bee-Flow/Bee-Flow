/**
 * skillModel — the pure reading of a skill row that every SkillsStudio
 * surface shares (Bee Flow Builder redesign, Sep 2026; Skills artboard
 * 1a/1c, plan S2).
 *
 * The list subline, the overview's meta line, the test chip and the sort
 * order are the SAME four sentences in three places (the 280px list, the
 * "All skills" table, the delete confirmation). They live here, React-free
 * and fetch-free, so a skill cannot read "3 agents · 1 automation" on the
 * left and "3 agents" in the table.
 *
 * ── NULL IS NOT [] ──────────────────────────────────────────────────
 * S1 stores a structured facet as NULL until something writes it, and
 * `skillStore.mapRow` already turns that into `[]` on the way out. A client
 * that trusts the column would still crash on a row minted by mobile (which
 * sends the six text fields only), so every reader here normalises: a
 * missing facet is an empty list, never a throw and never `undefined.length`.
 *
 * ── ONE OR MANY IS A KEY, NEVER A LETTER ────────────────────────────
 * "2 steps · 1 rules · 0 examples" was on the first screen of the section,
 * and a skill with one rule is an ordinary skill. `nOf` (the product's own
 * helper, KnowledgeStudio/plural.js) puts the ternary around the KEY —
 * base = singular, `<key>_plural` = many — so a translator sees the pair and
 * i18nGuard can check both halves exist. Baking `rule${n === 1 ? '' : 's'}`
 * into the sentence would be English grammar in JavaScript, which no
 * translation can undo (I18N-CONVENTIES §2.3).
 *
 * ── THE USAGE SUBLINE NEVER GUESSES ─────────────────────────────────
 * `GET /api/skills/usage-summary` omits a skill it cannot count. "not
 * linked yet" is a claim about the world, so it is only made from a row
 * that ANSWERED; a skill with no summary row yet renders nothing at all
 * rather than an encouraging lie. `draft · empty` is different: that is a
 * statement about the skill's own content, which the list row already has.
 */

import { nOf } from '../KnowledgeStudio/plural';

/** The three things a step may point at (S1 `steps[].refs[].kind`). */
export const REF_KINDS = Object.freeze(['automation', 'kb', 'table']);

/** The two polarities of a rule (S1 `rules_v2[].polarity`). */
export const RULE_POLARITIES = Object.freeze(['must', 'never']);

/** How the "All skills" table can be ordered (artboard 1c, right). */
export const SORT_MODES = Object.freeze(['used', 'recent', 'name']);

/** A ref kind → the kindColors key that paints it. `table` is a datatable. */
export function refKindKey(refKind) {
    if (refKind === 'kb') return 'kb';
    if (refKind === 'table') return 'datatable';
    if (refKind === 'automation') return 'automation';
    return null;
}

/**
 * A client-side id for a new step / rule / example. The server keeps
 * whatever id it is given (S1 validates the shape, not the provenance), and
 * a stable id is what lets dnd-kit and React key a row that has no text yet.
 */
let seq = 0;
export function newLocalId(prefix = 'x') {
    seq += 1;
    const rand = Math.random().toString(36).slice(2, 8);
    return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}${rand}`;
}

/** Any nullable list facet → a real array. */
function list(value) {
    return Array.isArray(value) ? value : [];
}

/** `skill.steps`, normalised: every entry has an id, a text and a refs array. */
export function stepsOf(skill) {
    return list(skill?.steps).map((raw, i) => ({
        id: (raw && typeof raw.id === 'string' && raw.id) || `step_${i + 1}`,
        text: typeof raw?.text === 'string' ? raw.text : '',
        refs: list(raw?.refs)
            .filter(r => r && REF_KINDS.includes(r.kind) && r.id != null && r.id !== '')
            .map(r => ({ kind: r.kind, id: String(r.id) })),
    }));
}

/** `skill.rulesV2`, normalised. An unknown polarity reads as `must`. */
export function rulesOf(skill) {
    return list(skill?.rulesV2).map((raw, i) => ({
        id: (raw && typeof raw.id === 'string' && raw.id) || `rule_${i + 1}`,
        polarity: RULE_POLARITIES.includes(raw?.polarity) ? raw.polarity : 'must',
        text: typeof raw?.text === 'string' ? raw.text : '',
    }));
}

/** `skill.examplesV2`, normalised. `bad` and `violatedRuleId` stay optional. */
export function examplesOf(skill) {
    return list(skill?.examplesV2).map((raw, i) => ({
        id: (raw && typeof raw.id === 'string' && raw.id) || `ex_${i + 1}`,
        question: typeof raw?.question === 'string' ? raw.question : '',
        good: typeof raw?.good === 'string' ? raw.good : '',
        rationale: typeof raw?.rationale === 'string' ? raw.rationale : '',
        bad: typeof raw?.bad === 'string' ? raw.bad : '',
        violatedRuleId: typeof raw?.violatedRuleId === 'string' ? raw.violatedRuleId : '',
        sourceConversationId: typeof raw?.sourceConversationId === 'string' ? raw.sourceConversationId : '',
    }));
}

/** The ids a skill may use, normalised to string arrays. */
export function idsOf(skill, field) {
    return list(skill?.[field]).filter(v => typeof v === 'string' && v).map(String);
}

/**
 * Every `steps[].refs` entry of one kind, de-duplicated and in step order.
 * This is what the overview's "uses table Pricelist" line is derived from
 * (plan S2: derived from the refs, never a second column).
 */
export function refIdsOfKind(skill, kind) {
    const seen = new Set();
    for (const step of stepsOf(skill)) {
        for (const ref of step.refs) if (ref.kind === kind) seen.add(ref.id);
    }
    return [...seen];
}

/** A skill nobody has written anything into yet — the "draft · empty" row. */
export function isEmptySkill(skill) {
    return stepsOf(skill).length === 0 && !String(skill?.description || '').trim();
}

/**
 * "4 steps · 3 rules · 2 examples" (artboard 1c). An empty skill says so
 * instead of "0 steps · 0 rules · 0 examples", which is three facts where
 * one word does.
 */
export function metaLine(skill, t) {
    if (isEmptySkill(skill)) return t('skills_studio.meta.empty', 'draft · empty');
    const parts = [
        nOf(t, 'skills_studio.meta.steps', stepsOf(skill).length, '{count} step', '{count} steps'),
        nOf(t, 'skills_studio.meta.rules', rulesOf(skill).length, '{count} rule', '{count} rules'),
        nOf(t, 'skills_studio.meta.examples', examplesOf(skill).length, '{count} example', '{count} examples'),
    ];
    return parts.join(' · ');
}

/**
 * "3 agents · 1 automation" · "not linked yet" · "draft · empty".
 *
 * `summary` is the `usage-summary` entry for this skill, or undefined when
 * the endpoint has not answered for it. Undefined returns '' — an unknown
 * count is not "nobody".
 */
export function usageSubline(skill, summary, t) {
    if (isEmptySkill(skill)) return t('skills_studio.meta.empty', 'draft · empty');
    if (!summary) return '';
    const agents = Number(summary.agents) || 0;
    const automations = Number(summary.automations) || 0;
    // The server says so when it could not count a kind at all (an install
    // with no automations table). "not linked yet" is a claim about the
    // world; zeros that nobody counted may not make it.
    if (summary.automationsUnchecked && agents === 0) {
        return t('skills_studio.usage.unknown', 'not counted');
    }
    if (agents === 0 && automations === 0) return t('skills_studio.usage.none', 'not linked yet');
    const parts = [];
    if (agents > 0) parts.push(nOf(t, 'skills_studio.usage.agents', agents, '{count} agent', '{count} agents'));
    if (automations > 0) parts.push(nOf(t, 'skills_studio.usage.automations', automations, '{count} automation', '{count} automations'));
    return parts.join(' · ');
}

/**
 * The Test column of the overview (artboard 1c): the `lastTest` S1 puts on
 * every `GET /api/skills` row.
 *   null            → "not tested"           (tertiary)
 *   status 'ok'     → "ok"                   (success)
 *   advice n>0      → "n advice"             (warning)
 *   status 'error'  → "failed"               (error)
 * An empty skill offers "Let AI fill it in" instead — that is a different
 * answer to a different question and the caller decides which to render.
 */
export function testChip(lastTest, t) {
    if (!lastTest || !lastTest.status) {
        return { tone: 'idle', label: t('skills_studio.test.untested', 'not tested') };
    }
    if (lastTest.status === 'error') {
        return { tone: 'error', label: t('skills_studio.test.failed', 'failed') };
    }
    const advice = Number(lastTest.adviceCount) || 0;
    if (lastTest.status === 'warning' || advice > 0) {
        return { tone: 'warning', label: t('skills_studio.test.advice', '{count} advice', { count: advice || 1 }) };
    }
    return { tone: 'ok', label: t('skills_studio.test.ok', 'ok') };
}

/** `--success` / `--warning` / `--error` / tertiary — never a hex. */
export function testChipColor(tone) {
    if (tone === 'ok') return 'var(--success-ink)';
    if (tone === 'warning') return 'var(--warning-ink)';
    if (tone === 'error') return 'var(--error-ink)';
    return 'var(--text-tertiary)';
}

/** Free-text filter over the list (name + description), case-insensitive. */
export function filterSkills(skills, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return list(skills);
    return list(skills).filter(s => `${s?.name || ''} ${s?.description || ''}`.toLowerCase().includes(q));
}

function usageWeight(summary) {
    if (!summary) return 0;
    return (Number(summary.agents) || 0) + (Number(summary.automations) || 0);
}

function lastUsedMs(skill, summary) {
    const iso = summary?.lastUsedAt || skill?.lastUsedAt || null;
    if (!iso) return 0;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : 0;
}

/**
 * The overview's sort (artboard 1c: "Sort: most used"). Stable and total:
 * ties fall back to the name so two renders of the same data cannot swap
 * two rows. Returns a NEW array; the caller's list is never mutated.
 */
export function sortSkills(skills, mode, summary) {
    const rows = list(skills).slice();
    const sum = (id) => (summary && summary[id]) || null;
    const byName = (a, b) => String(a?.name || '').localeCompare(String(b?.name || ''));
    if (mode === 'name') return rows.sort(byName);
    if (mode === 'recent') {
        return rows.sort((a, b) => (lastUsedMs(b, sum(b.id)) - lastUsedMs(a, sum(a.id))) || byName(a, b));
    }
    return rows.sort((a, b) => (usageWeight(sum(b.id)) - usageWeight(sum(a.id))) || byName(a, b));
}

/**
 * The body of an autosave PUT.
 *
 * It sends the STRUCTURE and never `workflow` / `rules` / `examples`: S1's
 * precedence rule regenerates those text columns from the structure, and a
 * body carrying both would make the text win and silently re-mint every
 * step id (skillStructure.resolveBodyWrite). The six text fields mobile
 * sends stay valid — this client simply is not one of them.
 */
export function buildSavePayload(draft) {
    return {
        name: draft.name,
        description: draft.description,
        instructions: draft.instructions,
        icon: draft.icon,
        isShared: draft.isShared,
        dynamicActivation: draft.dynamicActivation,
        sharedGroups: draft.sharedGroups,
        enabledIntegrations: draft.enabledIntegrations,
        steps: draft.steps,
        rulesV2: draft.rulesV2,
        examplesV2: draft.examplesV2,
        outputSchema: draft.outputSchema,
        knowledgeBaseIds: draft.knowledgeBaseIds,
        allowedAutomationIds: draft.allowedAutomationIds,
    };
}

/** The editable draft a detail view starts from — every facet normalised. */
export function draftOf(skill) {
    return {
        name: skill?.name || '',
        description: skill?.description || '',
        instructions: skill?.instructions || '',
        icon: skill?.icon || '⚡',
        isShared: !!skill?.isShared,
        dynamicActivation: !!skill?.dynamicActivation,
        sharedGroups: idsOf(skill, 'sharedGroups'),
        enabledIntegrations: idsOf(skill, 'enabledIntegrations'),
        steps: stepsOf(skill),
        rulesV2: rulesOf(skill),
        examplesV2: examplesOf(skill),
        outputSchema: skill?.outputSchema ?? null,
        knowledgeBaseIds: idsOf(skill, 'knowledgeBaseIds'),
        allowedAutomationIds: idsOf(skill, 'allowedAutomationIds'),
    };
}

/**
 * Is this routine callable by an agent? "May use" means "offered as a tool",
 * and only an `agent_call`-trigger routine ever is (S1 §5). The row's shape
 * differs per endpoint, so all three spellings are accepted — and an absent
 * trigger is NOT treated as a match: offering a routine the runtime will
 * never dispatch is a promise the product cannot keep.
 *
 * ── THE DEFINITION COMES FIRST, AND THAT ORDER IS THE WHOLE POINT ───
 * `definition.trigger.kind` is what the RUNTIME dispatches on
 * (automation/agentCallableTools.js). `trigger_type` is a denormalised column
 * with `DEFAULT 'manual'`, and every row from `GET /api/automation` carries it
 * (rowMappers maps it unconditionally) — so with the column read first the
 * third spelling was unreachable on the one endpoint this function is used
 * with, and "all three spellings are accepted" was not true.
 *
 * That is not a theoretical drift. `PUT /api/automation/:id` derives the
 * column from the definition precisely because the visual editor only ever
 * sends `definition` (BFSF-318: a schedule set in the node panel left
 * trigger_type at 'manual' and never fired). `POST` still does NOT derive it —
 * it takes `triggerType` from the body with default 'manual' — and a routine
 * can arrive complete in one POST (duplicate, template, create-from-chat). Such
 * a row keeps trigger_type='manual' until somebody saves it again, and the
 * picker then hid a routine the runtime WOULD call, under the sentence "a
 * routine appears here once its trigger is 'an agent calls it'".
 */
export function isAgentCallable(automation) {
    const kind = automation?.definition?.trigger?.kind
        ?? automation?.triggerKind
        ?? automation?.triggerType
        ?? null;
    return kind === 'agent_call';
}

/** Move one item of an array; returns a new array (dnd-kit reorder). */
export function moveItem(items, from, to) {
    const rows = list(items).slice();
    if (from < 0 || to < 0 || from >= rows.length || to >= rows.length || from === to) return rows;
    const [row] = rows.splice(from, 1);
    rows.splice(to, 0, row);
    return rows;
}
