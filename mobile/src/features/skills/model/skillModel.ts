/**
 * The pure reading of a skill row — a port of the web's
 * agent-hub/src/components/admin/Studio/SkillsStudio/skillModel.js, held to
 * it by skillModel.lockstep.test.ts, which runs both on the same fixtures.
 *
 * The list subline, the meta line, the test chip and the sort order are the
 * same sentences on the web and here, so a skill cannot read
 * "3 agents · 1 automation" in one client and "3 agents" in the other.
 *
 * NULL IS NOT []: every reader normalises, so a row minted by an older client
 * (text fields only) never reaches an editor as `undefined.length`.
 *
 * THE USAGE SUBLINE NEVER GUESSES: an entry the usage summary does not have
 * renders nothing, because "not linked yet" is a claim about the world.
 */

import type { TranslateFn } from '@/core/i18n';
import { nOf } from '@/shared/lib/plural';

import type {
    LastTest,
    RefKind,
    RulePolarity,
    Skill,
    SkillDraft,
    SkillExample,
    SkillRule,
    SkillStep,
    UsageSummary,
    UsageSummaryEntry,
} from './types';

export const REF_KINDS: readonly RefKind[] = Object.freeze(['automation', 'kb', 'table']);
export const RULE_POLARITIES: readonly RulePolarity[] = Object.freeze(['must', 'never']);
export const SORT_MODES = Object.freeze(['used', 'recent', 'name'] as const);
export type SortMode = (typeof SORT_MODES)[number];

type Row = Record<string, unknown>;
type SkillLike = Partial<Skill> | Record<string, unknown> | null | undefined;

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const rowOf = (value: unknown): Row => (value && typeof value === 'object' ? (value as Row) : {});
const facet = (skill: SkillLike, key: string): unknown[] => list(rowOf(skill)[key]);
const idOf = (raw: Row, fallback: string): string => (typeof raw.id === 'string' && raw.id ? raw.id : fallback);

/** A ref kind → the kinds.ts key that paints it. `table` is a datatable. */
export function refKindKey(refKind: string): 'kb' | 'datatable' | 'automation' | null {
    if (refKind === 'kb') return 'kb';
    if (refKind === 'table') return 'datatable';
    if (refKind === 'automation') return 'automation';
    return null;
}

let seq = 0;
/** A client-side id for a new step / rule / example; the server keeps it. */
export function newLocalId(prefix = 'x'): string {
    seq += 1;
    // nosemgrep: ajinabraham.njsscan.crypto.crypto_node.node_insecure_random_generator -- a client-side id for a new step, rule or example, not a security token; the timestamp and counter keep it unique
    const rand = Math.random().toString(36).slice(2, 8);
    return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}${rand}`;
}

export function stepsOf(skill: SkillLike): SkillStep[] {
    return facet(skill, 'steps').map((value, i) => {
        const raw = rowOf(value);
        return {
            id: idOf(raw, `step_${i + 1}`),
            text: text(raw.text),
            refs: list(raw.refs)
                .map(rowOf)
                .filter((r) => REF_KINDS.includes(r.kind as RefKind) && r.id != null && r.id !== '')
                .map((r) => ({ kind: r.kind as RefKind, id: String(r.id) })),
        };
    });
}

/** An unknown polarity reads as `must`. */
export function rulesOf(skill: SkillLike): SkillRule[] {
    return facet(skill, 'rulesV2').map((value, i) => {
        const raw = rowOf(value);
        const polarity = RULE_POLARITIES.includes(raw.polarity as RulePolarity) ? (raw.polarity as RulePolarity) : 'must';
        return { id: idOf(raw, `rule_${i + 1}`), polarity, text: text(raw.text) };
    });
}

export function examplesOf(skill: SkillLike): SkillExample[] {
    return facet(skill, 'examplesV2').map((value, i) => {
        const raw = rowOf(value);
        return {
            id: idOf(raw, `ex_${i + 1}`),
            question: text(raw.question),
            good: text(raw.good),
            rationale: text(raw.rationale),
            bad: text(raw.bad),
            violatedRuleId: text(raw.violatedRuleId),
            sourceConversationId: text(raw.sourceConversationId),
        };
    });
}

export function idsOf(skill: SkillLike, key: string): string[] {
    return facet(skill, key)
        .filter((v): v is string => typeof v === 'string' && v !== '')
        .map(String);
}

/** Every `steps[].refs` id of one kind, de-duplicated, in step order. */
export function refIdsOfKind(skill: SkillLike, kind: RefKind): string[] {
    const seen = new Set<string>();
    for (const step of stepsOf(skill)) for (const ref of step.refs) if (ref.kind === kind) seen.add(ref.id);
    return [...seen];
}

export function isEmptySkill(skill: SkillLike): boolean {
    return stepsOf(skill).length === 0 && !String(rowOf(skill).description || '').trim();
}

/** "4 steps · 3 rules · 2 examples", or "draft · empty". */
export function metaLine(skill: SkillLike, t: TranslateFn): string {
    if (isEmptySkill(skill)) return t('skills_studio.meta.empty', 'draft · empty');
    return [
        nOf(t, 'skills_studio.meta.steps', stepsOf(skill).length, ['{count} step', '{count} steps']),
        nOf(t, 'skills_studio.meta.rules', rulesOf(skill).length, ['{count} rule', '{count} rules']),
        nOf(t, 'skills_studio.meta.examples', examplesOf(skill).length, ['{count} example', '{count} examples']),
    ].join(' · ');
}

/** "3 agents · 1 automation" · "not linked yet" · "draft · empty" · '' when unknown. */
export function usageSubline(skill: SkillLike, summary: UsageSummaryEntry | undefined | null, t: TranslateFn): string {
    if (isEmptySkill(skill)) return t('skills_studio.meta.empty', 'draft · empty');
    if (!summary) return '';
    const agents = Number(summary.agents) || 0;
    const automations = Number(summary.automations) || 0;
    if (summary.automationsUnchecked && agents === 0) return t('skills_studio.usage.unknown', 'not counted');
    if (agents === 0 && automations === 0) return t('skills_studio.usage.none', 'not linked yet');
    const parts: string[] = [];
    if (agents > 0) parts.push(nOf(t, 'skills_studio.usage.agents', agents, ['{count} agent', '{count} agents']));
    if (automations > 0) {
        parts.push(nOf(t, 'skills_studio.usage.automations', automations, ['{count} automation', '{count} automations']));
    }
    return parts.join(' · ');
}

export type TestTone = 'idle' | 'ok' | 'warning' | 'error';

export function testChip(lastTest: LastTest | null | undefined, t: TranslateFn): { tone: TestTone; label: string } {
    if (!lastTest || !lastTest.status) return { tone: 'idle', label: t('skills_studio.test.untested', 'not tested') };
    if (lastTest.status === 'error') return { tone: 'error', label: t('skills_studio.test.failed', 'failed') };
    const advice = Number(lastTest.adviceCount) || 0;
    if (lastTest.status === 'warning' || advice > 0) {
        return { tone: 'warning', label: t('skills_studio.test.advice', '{count} advice', { count: advice || 1 }) };
    }
    return { tone: 'ok', label: t('skills_studio.test.ok', 'ok') };
}

export function filterSkills<T extends SkillLike>(skills: readonly T[] | null | undefined, query: string): T[] {
    const q = String(query || '').trim().toLowerCase();
    const rows = Array.isArray(skills) ? [...skills] : [];
    if (!q) return rows;
    return rows.filter((s) => `${text(rowOf(s).name)} ${text(rowOf(s).description)}`.toLowerCase().includes(q));
}

function usageWeight(summary: UsageSummaryEntry | null): number {
    if (!summary) return 0;
    return (Number(summary.agents) || 0) + (Number(summary.automations) || 0);
}

function lastUsedMs(skill: SkillLike, summary: UsageSummaryEntry | null): number {
    const iso = summary?.lastUsedAt || (rowOf(skill).lastUsedAt as string | null | undefined) || null;
    if (!iso) return 0;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : 0;
}

/** Stable and total: ties fall back to the name. Returns a new array. */
export function sortSkills<T extends SkillLike>(skills: readonly T[] | null | undefined, mode: SortMode, summary?: UsageSummary | null): T[] {
    const rows = Array.isArray(skills) ? [...skills] : [];
    const sum = (s: T) => (summary && summary[text(rowOf(s).id)]) || null;
    const byName = (a: T, b: T) => text(rowOf(a).name).localeCompare(text(rowOf(b).name));
    if (mode === 'name') return rows.sort(byName);
    if (mode === 'recent') return rows.sort((a, b) => lastUsedMs(b, sum(b)) - lastUsedMs(a, sum(a)) || byName(a, b));
    return rows.sort((a, b) => usageWeight(sum(b)) - usageWeight(sum(a)) || byName(a, b));
}

/** The autosave body: the STRUCTURE, never `workflow` / `rules` / `examples`. */
export function buildSavePayload(draft: SkillDraft): SkillDraft {
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

export function draftOf(skill: SkillLike): SkillDraft {
    const raw = rowOf(skill);
    const schema = raw.outputSchema;
    return {
        name: text(raw.name),
        description: text(raw.description),
        instructions: text(raw.instructions),
        icon: text(raw.icon) || '⚡',
        isShared: !!raw.isShared,
        dynamicActivation: !!raw.dynamicActivation,
        sharedGroups: idsOf(skill, 'sharedGroups'),
        enabledIntegrations: idsOf(skill, 'enabledIntegrations'),
        steps: stepsOf(skill),
        rulesV2: rulesOf(skill),
        examplesV2: examplesOf(skill),
        outputSchema: schema && typeof schema === 'object' ? (schema as Record<string, unknown>) : null,
        knowledgeBaseIds: idsOf(skill, 'knowledgeBaseIds'),
        allowedAutomationIds: idsOf(skill, 'allowedAutomationIds'),
    };
}

/**
 * Only an `agent_call`-trigger routine is ever offered as a tool. The
 * definition comes first: it is what the runtime dispatches on, while
 * `triggerType` is a denormalised column that defaults to 'manual'.
 */
export function isAgentCallable(automation: unknown): boolean {
    const row = rowOf(automation);
    const kind = rowOf(rowOf(row.definition).trigger).kind ?? row.triggerKind ?? row.triggerType ?? null;
    return kind === 'agent_call';
}

/** Move one item; returns a new array. Out-of-range moves are a no-op copy. */
export function moveItem<T>(items: readonly T[] | null | undefined, from: number, to: number): T[] {
    const rows = Array.isArray(items) ? [...items] : [];
    if (from < 0 || to < 0 || from >= rows.length || to >= rows.length || from === to) return rows;
    const [row] = rows.splice(from, 1);
    rows.splice(to, 0, row as T);
    return rows;
}
