/**
 * The Skill store's reading of the skill list: which skills a tab shows and
 * in what order. Pure, so the tab rules are tested without a screen.
 *
 *   popular    most used first (GET /api/skills/store-stats `uses`), the top 12
 *   lastused   the ones YOU used, most recent first
 *   favorites  the ones you marked (per browser, scopedStorage)
 *   all        A to Z
 *   cat:<name> one category (the owner's free-text label)
 *
 * The rows are what `GET /api/skills` answers: only skills this account may
 * see (its own, shared with the organisation or one of its groups).
 */
import type { SkillStoreStats } from '@/api/skillStoreApi';

export interface StoreSkill {
    id: string;
    name?: string;
    description?: string;
    userId?: string;
    category?: string | null;
    dynamicActivation?: boolean;
    automationId?: string | null;
    agentOnly?: boolean;
    canEdit?: boolean;
    [key: string]: unknown;
}

const POPULAR_LIMIT = 12;
const CATEGORY_TAB = 'cat:';

export function categoryTab(category: string): string {
    return `${CATEGORY_TAB}${category}`;
}

const byName = (a: StoreSkill, b: StoreSkill) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });

function matches(s: StoreSkill, q: string): boolean {
    if (!q) return true;
    return `${s.name || ''} ${s.description || ''} ${s.category || ''}`.toLowerCase().includes(q);
}

export interface StoreFilter {
    tab: string;
    query?: string;
    stats?: SkillStoreStats | null;
    favorites?: readonly string[];
}

export function storeSkills(skills: readonly StoreSkill[], { tab, query = '', stats = null, favorites = [] }: StoreFilter): StoreSkill[] {
    const q = query.trim().toLowerCase();
    const list = skills.filter((s) => matches(s, q));
    const uses = (s: StoreSkill) => stats?.[s.id]?.uses || 0;
    const mine = (s: StoreSkill) => {
        const at = stats?.[s.id]?.lastUsedByMeAt;
        const ms = at ? Date.parse(at) : 0;
        return Number.isFinite(ms) ? ms : 0;
    };
    if (tab === 'popular') return [...list].sort((a, b) => uses(b) - uses(a) || byName(a, b)).slice(0, POPULAR_LIMIT);
    if (tab === 'lastused') return list.filter((s) => mine(s) > 0).sort((a, b) => mine(b) - mine(a));
    if (tab === 'favorites') return list.filter((s) => favorites.includes(s.id)).sort(byName);
    if (tab.startsWith(CATEGORY_TAB)) {
        const c = tab.slice(CATEGORY_TAB.length);
        return list.filter((s) => (s.category || '').trim() === c).sort(byName);
    }
    return [...list].sort(byName);
}

/** Dynamic = the agent loads it when it decides to; an automation-linked skill always is (server isDynamicSkill). */
export function isDynamic(s: StoreSkill): boolean {
    return s.dynamicActivation === true || !!s.automationId;
}
