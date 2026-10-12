import { ORG_ROLES } from '../../config/orgRoles';

/**
 * The words on a person's role chip (the Settings mini-card and the
 * Preferences profile strip).
 *
 * One source for both, so they cannot drift again: the two screens each kept
 * a hand-written English table that lacked dpo and isms_auditor, so those
 * read 'Dpo' and 'Isms Auditor' while ORG_ROLES (config/orgRoles.js, the list
 * the role pickers offer) already had their real names.
 *
 *   - no role       → null (the caller draws no chip)
 *   - 'admin'       → the deployment super-admin, which is not an org role
 *   - an org role   → its ORG_ROLES name
 *   - anything else → the id prettified ('team_lead' → 'Team Lead')
 */
export function roleLabel(
    role: string | null | undefined,
    t: (key: string, fallback?: string) => string,
): string | null {
    if (!role) return null;
    if (role === 'admin') return t('settings.role_admin', 'Admin');
    const known = ORG_ROLES.find((r) => r.id === role)?.name;
    if (known) return known;
    return role.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
