/**
 * The pure half of filling in a template, alone or together in a project: who
 * can be asked, the line under each field (who filled it in, who was asked),
 * which fields are asked of the reader, and the one thing to do next.
 */
import type { ProjectMembers } from '@/api/queries/projects';
import { isOpenRequest, type FilledBy, type FillTeam, type ValueRequest } from '@/api/templateFillTeamApi';
import type { TranslateFn } from '@/hooks/useTranslation';

export interface Colleague { id: string; name: string }
type Values = Record<string, unknown>;

const isBlank = (v: unknown): boolean => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/** The project's people who may edit it (owner and editors), without the reader. */
export function colleaguesOf(members: ProjectMembers | undefined, meId: string | null): Colleague[] {
    if (!members) return [];
    const ids = new Set<string>();
    if (members.ownerId) ids.add(members.ownerId);
    for (const m of members.members) if (m.sharedWithType === 'user' && m.permission === 'editor') ids.add(m.sharedWithId);
    if (meId) ids.delete(meId);
    return [...ids].map((id) => ({ id, name: members.people[id]?.name || id })).sort((a, b) => a.name.localeCompare(b.name));
}

/** A person's name as this reader sees it: "you" for themselves. */
export function nameFor(members: ProjectMembers | undefined, meId: string | null, id: string, t: TranslateFn): string {
    if (id === meId) return t('doc_value_requests.you', 'you');
    return members?.people[id]?.name || t('doc_value_requests.someone', 'a colleague');
}

/** One line per field: who it was asked of while open, otherwise who filled it in (and that the assistant stored it). */
export function fieldHints(
    requests: ValueRequest[], filledBy: FilledBy, name: (id: string) => string, t: TranslateFn,
): Record<string, string> {
    const hints: Record<string, string> = {};
    for (const [key, who] of Object.entries(filledBy)) {
        hints[key] = who.via === 'ai'
            ? t('doc_value_requests.filled_by_ai', 'Filled in by {name}, with the assistant', { name: name(who.userId) })
            : t('doc_value_requests.filled_by', 'Filled in by {name}', { name: name(who.userId) });
    }
    const askedOf: Record<string, string[]> = {};
    for (const r of requests.filter(isOpenRequest)) {
        for (const key of r.fields) (askedOf[key] ||= []).push(name(r.assigneeId));
    }
    for (const [key, names] of Object.entries(askedOf)) {
        if (!filledBy[key]) hints[key] = t('doc_value_requests.asked_of', 'Asked of {names}', { names: [...new Set(names)].join(', ') });
    }
    return hints;
}

/** The fields colleagues asked this reader for that still have no value, in the order they were asked. */
export function askedOfMe(requests: ValueRequest[], meId: string | null, values: Values): string[] {
    if (!meId) return [];
    const keys = requests.filter((r) => isOpenRequest(r) && r.assigneeId === meId).flatMap((r) => r.fields);
    return [...new Set(keys)].filter((key) => isBlank(values[key]));
}

/** The one thing to do next, in the order a person would do it. */
export type GuideStep =
    | { kind: 'readOnly' }
    | { kind: 'done' }
    | { kind: 'asked'; count: number }
    | { kind: 'missing'; count: number; waiting: number }
    | { kind: 'remarks'; count: number }
    | { kind: 'check' }
    /** `checked` false: the assistant's check could not run, and it can be finished without it. */
    | { kind: 'finish'; checked: boolean };

export interface GuideInput {
    editable: boolean;
    finished: boolean;
    /** The keys of the required fields that are still empty. */
    missing: string[];
    team: FillTeam;
    meId: string | null;
    values: Values;
    /** Whether the assistant's check can still be run before finishing. */
    checkAhead: boolean;
}

export function guideStep({ editable, finished, missing, team, meId, values, checkAhead }: GuideInput): GuideStep {
    if (!editable) return { kind: 'readOnly' };
    if (finished) return { kind: 'done' };
    const mine = askedOfMe(team.requests, meId, values);
    if (mine.length) return { kind: 'asked', count: mine.length };
    if (missing.length) {
        const others = new Set(team.requests.filter((r) => isOpenRequest(r) && r.assigneeId !== meId).flatMap((r) => r.fields));
        return { kind: 'missing', count: missing.length, waiting: missing.filter((key) => others.has(key)).length };
    }
    const remarks = team.review?.findings.length ?? 0;
    if (remarks) return { kind: 'remarks', count: remarks };
    return checkAhead ? { kind: 'check' } : { kind: 'finish', checked: !!team.review };
}
