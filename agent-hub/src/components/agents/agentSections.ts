// Which sections of the admin Agents hub a viewer sees, and which one is
// open. Pure, so the choice can be tested without rendering the designer.

export interface AgentSectionUser {
    isAdmin?: boolean;
    role?: string;
    permissions?: string[] | null;
    allowedAgentTypes?: string[];
}

/** The hub's sections; each is also the agent type the section edits. */
const AGENT_SECTION_IDS: readonly string[] = ['chat', 'system'];

/** The sections the viewer may see and the open one (the requested one when visible, else the first visible). */
export function resolveAgentSection(user: AgentSectionUser | null | undefined, requested: string): { visible: string[]; active: string } {
    const isSuperAdmin = user?.isAdmin || user?.role === 'admin' || (user?.permissions || []).includes('all');
    const allowedTypes = user?.allowedAgentTypes || [];
    const hasRestrictions = !isSuperAdmin && allowedTypes.length > 0;
    const visible = hasRestrictions ? AGENT_SECTION_IDS.filter(id => allowedTypes.includes(id)) : [...AGENT_SECTION_IDS];
    return { visible, active: visible.includes(requested) ? requested : (visible[0] || 'chat') };
}
