// What the scope bar above a dashboard tab says, as data: pure, so every
// combination of section kind and viewer can be tested without rendering.

import type { AdminScope, FixedOrgView } from './adminTabs';

export type ScopeBarView =
    /** The whole server: every organisation on it. */
    | { kind: 'server' }
    /** The viewer's own account. */
    | { kind: 'personal' }
    /** A platform admin on a section that follows the organisation picker. */
    | { kind: 'picker' }
    /** One named organisation without a choice; `note` says why a platform admin has no picker here. */
    | { kind: 'org'; name: string | null; note: 'compliance' | null }
    /** A section that always lists every organisation. */
    | { kind: 'all-orgs' };

export interface ScopeBarInput {
    scope: AdminScope;
    isPlatformAdmin: boolean;
    /** The section does not follow the picker (adminTabs fixedOrgViewOf). */
    fixed: FixedOrgView | null;
    homeOrgName: string | null;
}

export function scopeBarView({ scope, isPlatformAdmin, fixed, homeOrgName }: ScopeBarInput): ScopeBarView {
    if (scope === 'instance') return { kind: 'server' };
    if (scope === 'user') return { kind: 'personal' };
    if (fixed === 'home') return { kind: 'org', name: homeOrgName, note: isPlatformAdmin ? 'compliance' : null };
    if (isPlatformAdmin) return fixed === 'all' ? { kind: 'all-orgs' } : { kind: 'picker' };
    return { kind: 'org', name: homeOrgName, note: null };
}
