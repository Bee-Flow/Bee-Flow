/** Who may change a skill — the server's verdict where it gives one. */

import type { Skill } from './types';

/**
 * May this session edit `skill`?
 *
 * The server's verdict, not a second opinion: routes/skills.js attaches
 * `canEdit` to every row from the same rule PUT enforces — owner, OR
 * `manage_skills` in the skill's OWN org. Recomputing that here is how an
 * editor drifts from the endpoint it saves to.
 *
 * FAIL-CLOSED on purpose: `=== true`, never `!== false`. A server older than
 * Track S1 sends no `canEdit`, and an unknown verdict must narrow to read-only
 * rather than paint an Edit button that ends in a 403.
 */
export function canEditSkill(skill: Skill): boolean {
    return skill.canEdit === true;
}

/**
 * Deleting is owner-or-admin, and does NOT require `manage_skills`. Still a
 * local rule because DELETE has no server verdict on the row to read.
 */
export function canDeleteSkill(skill: Skill, userId: string | undefined, isAdmin: boolean): boolean {
    return isAdmin || (Boolean(userId) && skill.userId === userId);
}
