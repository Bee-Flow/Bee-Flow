// Which sections of the admin Agents hub a viewer sees, and which one is
// open. Pure, so the choice can be tested without rendering the designer.

import { isAdminSectionVisible } from '@/components/admin/dashboard/adminTabs';
import { isPlatformAdmin } from '@/utils/adminAccess';

export interface AgentSectionUser {
    isAdmin?: boolean;
    role?: string;
    permissions?: string[] | null;
    allowedAgentTypes?: string[];
}

/** The hub's sections; each is also the agent type the section edits. */
const AGENT_SECTION_IDS: readonly string[] = ['chat', 'system'];

/**
 * The sections the viewer may see and the open one (the requested one when visible, else the first visible, none when nothing is visible).
 * A server-wide section (system agents) is for the platform admin only.
 */
export function resolveAgentSection(user: AgentSectionUser | null | undefined, requested: string): { visible: string[]; active: string } {
    const platformAdmin = isPlatformAdmin(user);
    const allowedTypes = user?.allowedAgentTypes || [];
    const hasRestrictions = !platformAdmin && allowedTypes.length > 0;
    const byType = hasRestrictions ? AGENT_SECTION_IDS.filter(id => allowedTypes.includes(id)) : [...AGENT_SECTION_IDS];
    const visible = byType.filter(id => isAdminSectionVisible('agents', platformAdmin, id));
    return { visible, active: visible.includes(requested) ? requested : (visible[0] ?? '') };
}
