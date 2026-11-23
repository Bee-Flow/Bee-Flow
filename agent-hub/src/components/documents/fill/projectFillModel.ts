/**
 * The pure half of filling in a template together in a project: who can be
 * asked, and the line under each field (who filled it in, who was asked).
 */
import type { ProjectMembers } from '@/api/queries/projects';
import { isOpenRequest, type FilledBy, type ValueRequest } from '@/api/templateFillTeamApi';
import type { TranslateFn } from '@/hooks/useTranslation';

export interface Colleague { id: string; name: string }

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

/** One line per field: who it was asked of while open, otherwise who filled it in. */
export function fieldNotes(
    requests: ValueRequest[], filledBy: FilledBy, name: (id: string) => string, t: TranslateFn,
): Record<string, string> {
    const notes: Record<string, string> = {};
    for (const [key, who] of Object.entries(filledBy)) {
        notes[key] = t('doc_value_requests.filled_by', 'Filled in by {name}', { name: name(who.userId) });
    }
    const askedOf: Record<string, string[]> = {};
    for (const r of requests.filter(isOpenRequest)) {
        for (const key of r.fields) (askedOf[key] ||= []).push(name(r.assigneeId));
    }
    for (const [key, names] of Object.entries(askedOf)) {
        if (!filledBy[key]) notes[key] = t('doc_value_requests.asked_of', 'Asked of {names}', { names: [...new Set(names)].join(', ') });
    }
    return notes;
}
