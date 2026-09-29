import { Bot, Zap } from 'lucide-react';
import { buildSearchResults } from '../stepPalette';
import type { IconType, StepPayload } from './ribbonCategories';

/**
 * The ribbon's "/" search (design 5a): every step, app action, building
 * block, agent and skill, found by its own words or by a synonym.
 *
 * Steps, apps and blocks come from stepPalette.buildSearchResults, which
 * already ranks on labels, descriptions and the palette keywords. This adds
 * two things it has no notion of: synonyms (someone typing "mail" wants the
 * step that says "email", and "sheet" means a datatable here) and the org's
 * agents and skills, which live outside the step catalog.
 */

/**
 * Words people use interchangeably. A query word found in a group is also
 * searched as each of its siblings; a direct hit still ranks first.
 */
export const SYNONYM_GROUPS: readonly string[][] = [
    ['mail', 'e-mail', 'email', 'send'],
    ['sheet', 'table', 'spreadsheet', 'datatable', 'excel'],
    ['file', 'document', 'doc', 'pdf'],
    ['folder', 'directory'],
    ['approve', 'approval', 'sign off', 'review'],
    ['chat', 'talk', 'message'],
    ['wait', 'delay', 'pause'],
    ['if', 'condition', 'branch', 'filter'],
    ['each', 'loop', 'repeat', 'for each'],
    ['summarise', 'summarize', 'summary'],
    ['notify', 'notification', 'alert'],
    ['calendar', 'agenda', 'meeting', 'event'],
    ['form', 'survey', 'questionnaire'],
    ['ai', 'llm', 'gpt', 'prompt'],
];

/** The query itself first, then each variant with one word swapped for a synonym. */
export function expandQuery(query: string): string[] {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const out = [q];
    const add = (v: string) => { if (v && !out.includes(v)) out.push(v); };
    for (const group of SYNONYM_GROUPS) {
        for (const word of group) {
            // Whole words only: "if" must not fire inside "notify".
            const re = new RegExp(`(^|\\s)${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`);
            if (!re.test(q)) continue;
            for (const sibling of group) if (sibling !== word) add(q.replace(re, `$1${sibling}`));
        }
    }
    return out.slice(0, 12);
}

export interface AgentRow {
    id: string;
    name: string;
    description?: string | null;
    canUse?: boolean;
    reason?: string | null;
}

export interface SkillRow {
    id: string;
    name?: string;
    description?: string;
}

export interface RibbonResult {
    key: string;
    Icon?: IconType | null;
    integrationId?: string | null;
    tool?: string | null;
    label: string;
    secondary?: string;
    context?: string;
    payload: StepPayload;
    disabled?: boolean;
    disabledReason?: string;
    /** Inert because the plan does not include it (stepPalette.gated): the row shows a lock. */
    planLocked?: boolean;
    /** 'agent' | 'skill' tints the row in its own colour. */
    tone?: 'agent' | 'skill' | null;
}

/** The ai_step payload that puts an agent to work (applyAddNode reads `agentId`). */
export function agentPayload(agent: AgentRow): StepPayload {
    return { kind: 'ai_step', label: agent.name, agentId: agent.id };
}

/** The ai_step payload that applies one skill without an agent (`skillIds`, first leads). */
export function skillPayload(skill: SkillRow): StepPayload {
    return { kind: 'ai_step', label: skill.name || skill.id, skillIds: [skill.id] };
}

export function agentResult(agent: AgentRow, context = 'Agent'): RibbonResult {
    return {
        key: `agent:${agent.id}`, Icon: Bot, label: agent.name,
        secondary: agent.description || undefined, context, tone: 'agent',
        payload: agentPayload(agent),
        ...(agent.canUse === false ? { disabled: true, disabledReason: agent.reason || undefined } : null),
    };
}

export function skillResult(skill: SkillRow, context = 'Skill'): RibbonResult {
    return {
        key: `skill:${skill.id}`, Icon: Zap, label: skill.name || skill.id,
        secondary: skill.description || undefined, context, tone: 'skill',
        payload: skillPayload(skill),
    };
}

// Same buckets as stepPalette's rank(): 0 exact · 1 starts · 2 contains · 3 elsewhere.
function bucketFor(name: string, desc: string, typeWord: string, q: string): number {
    const n = name.toLowerCase();
    if (n === q) return 0;
    if (n.startsWith(q)) return 1;
    if (n.includes(q)) return 2;
    if (desc.toLowerCase().includes(q) || typeWord.startsWith(q)) return 3;
    return -1;
}

interface RankedResult extends RibbonResult {
    _score: number;
    _order: number;
}

export interface RibbonSearchOptions {
    agents?: AgentRow[] | null;
    skills?: SkillRow[] | null;
    limit?: number;
}

export function searchRibbon(query: string, scope: Record<string, unknown> = {}, { agents = [], skills = [], limit = 30 }: RibbonSearchOptions = {}): RibbonResult[] {
    const variants = expandQuery(query);
    if (!variants.length) return [];
    const best = new Map<string, RankedResult>();
    let order = 0;
    const offer = (r: RibbonResult, score: number) => {
        const id = `${r.payload?.kind}|${r.key}|${r.label}`;
        const cur = best.get(id);
        if (!cur || score < cur._score) best.set(id, { ...r, _score: score, _order: cur ? cur._order : order++ });
    };
    variants.forEach((v, vi) => {
        // A synonym hit ranks half a bucket below the same hit on the typed word.
        const penalty = vi === 0 ? 0 : 0.5;
        const found = buildSearchResults(v, { ...scope, mode: 'step' }) as Array<RibbonResult & { _bucket: number }>;
        for (const r of found) {
            // Triggers change on the start card; the ribbon only adds steps.
            if (r.payload?.kind === 'trigger') continue;
            const { _bucket, ...rest } = r;
            offer(rest, _bucket + penalty);
        }
        for (const a of agents || []) {
            const b = bucketFor(a.name || '', a.description || '', 'agent', v);
            if (b >= 0) offer(agentResult(a), b + penalty);
        }
        for (const s of skills || []) {
            const b = bucketFor(s.name || '', s.description || '', 'skill', v);
            if (b >= 0) offer(skillResult(s), b + penalty);
        }
    });
    return [...best.values()]
        .sort((a, b) => a._score - b._score || a._order - b._order)
        .slice(0, limit)
        .map(({ _score, _order, ...r }) => r);
}
