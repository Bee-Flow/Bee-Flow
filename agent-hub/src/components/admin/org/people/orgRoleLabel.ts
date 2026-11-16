// The organisation role as the admin screens name it, translated and in
// sentence case. config/orgRoles.ts keeps the English catalogue the role
// editor reads; a person's row reads this, so "Organisation admin", "Member"
// and a plain account (system role `user`, no organisation role) all read the
// same way in every language.

import type { TranslateFn } from '@/hooks/useTranslation';

const ROLE_LABELS: Readonly<Record<string, readonly [key: string, fallback: string]>> = {
    org_admin: ['admin_people.role_org_admin', 'Organisation admin'],
    dpo: ['admin_people.role_dpo', 'Data protection officer'],
    isms_auditor: ['admin_people.role_isms_auditor', 'ISMS internal auditor'],
    agent_admin: ['admin_people.role_agent_admin', 'Agent admin'],
    agent_editor: ['admin_people.role_agent_editor', 'Agent editor'],
    member: ['admin_people.role_member', 'Member'],
    // An account without an organisation role: a member.
    user: ['admin_people.role_member', 'Member'],
};

/**
 * The label of an organisation role id; an id this list does not know shows as
 * it is. `admin` is left as it is on purpose: callers pass `orgRole || role`,
 * and a platform admin's system role is `admin` too, so reading it as
 * "Organisation admin" would mislabel the operator. (Server side, `admin` is
 * also the pre-rename alias of `org_admin`; mapping it here needs the two
 * columns separated at the call site first.)
 */
export function orgRoleLabel(t: TranslateFn, role: string | null | undefined): string {
    const entry = ROLE_LABELS[role || 'user'];
    return entry ? t(entry[0], entry[1]) : String(role);
}
