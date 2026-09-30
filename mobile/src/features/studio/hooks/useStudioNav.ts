/**
 * The Studio sections this session is offered, grouped, and whether it gets
 * Studio at all — one snapshot, one resolution, for the drawer, the tab bar
 * and the hub alike (model/resolve.ts holds the rules).
 */

import { useMemo } from 'react';

import { useAccess, type AccessSnapshot } from '@/core/access';

import { canSeeStudio, groupSections, studioNavSections } from '../model/resolve';
import type { ResolvedSection, StudioGroup } from '../model/types';

export interface StudioNav {
    access: AccessSnapshot;
    /** Gate-passing and locked sections, minus Approvals (it has its own row). */
    sections: ResolvedSection[];
    groups: StudioGroup[];
    /** The web's canSeeStudio: a builder, not in Simple Mode, with something to open. */
    canSee: boolean;
}

/**
 * One object per access snapshot (which is itself stable while nothing
 * changed): the drawer hands this to rows that sit above a list, and a new
 * object on every render re-rendered all of them on every navigation.
 */
export function useStudioNav(): StudioNav {
    const access = useAccess();
    return useMemo(() => {
        const sections = studioNavSections(access);
        return { access, sections, groups: groupSections(sections), canSee: canSeeStudio(access, sections) };
    }, [access]);
}
