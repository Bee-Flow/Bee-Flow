/**
 * The Skills list's reading of categories, of who may delete which skill and
 * of which empty drafts the one-click clean-up may remove (2026-11). Pure, next
 * to skillModel.ts, which reads one skill.
 */
import { isEmptySkill } from './skillModel';
import type { Skill, UsageSummaryMap } from './skillModel.types';

/** A category as compared and shown: trimmed text, or null for none. */
function categoryOf(skill: Skill | null | undefined): string | null {
    const c = typeof skill?.category === 'string' ? skill.category.trim() : '';
    return c || null;
}

/** Every category the given skills carry, once, A to Z: the suggestions of the category field. */
export function categoriesOf(skills: Skill[] | null | undefined): string[] {
    const seen = new Set<string>();
    for (const s of skills || []) {
        const c = categoryOf(s);
        if (c) seen.add(c);
    }
    return [...seen].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

/** The list grouped by category, A to Z, the skills without one in a last group (`category: null`). */
export function groupByCategory<T extends Skill>(skills: T[]): { category: string | null; skills: T[] }[] {
    const groups = new Map<string, T[]>();
    const none: T[] = [];
    for (const s of skills) {
        const c = categoryOf(s);
        if (!c) { none.push(s); continue; }
        const g = groups.get(c);
        if (g) g.push(s); else groups.set(c, [s]);
    }
    const named = categoriesOf(skills).map((c) => ({ category: c as string | null, skills: groups.get(c) || [] }));
    return none.length > 0 ? [...named, { category: null, skills: none }] : named;
}

interface DeleteViewer { id?: string; isAdmin?: boolean; role?: string }

/**
 * May this account delete the skill? The server decides (DELETE /api/skills/:id:
 * the owner, or an admin); this only decides whether the action is drawn.
 */
export function canDeleteSkill(skill: Skill, user: DeleteViewer | null | undefined, canManage: boolean): boolean {
    if (!canManage || !user) return false;
    if (user.isAdmin || user.role === 'admin') return true;
    return !!user.id && skill.userId === user.id;
}

/**
 * The empty drafts ("Untitled skill · draft · empty") the one-click clean-up
 * may remove: empty, deletable by this account, and counted by the usage
 * summary as used by nothing. No summary, or a scan that could not count the
 * automations, is no answer, and then nothing is offered.
 */
export function cleanableDrafts<T extends Skill>(skills: T[], summary: UsageSummaryMap | null | undefined, user: DeleteViewer | null | undefined, canManage: boolean): T[] {
    if (!summary) return [];
    return skills.filter((s) => {
        const u = summary[s.id];
        if (!u || u.automationsUnchecked) return false;
        return isEmptySkill(s) && canDeleteSkill(s, user, canManage)
            && (Number(u.agents) || 0) === 0 && (Number(u.automations) || 0) === 0;
    });
}
