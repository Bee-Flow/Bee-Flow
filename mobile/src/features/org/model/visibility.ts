/**
 * Which organisation sections a session is offered — the web's `orgSubItems`
 * filter (pages/AdvancedSettings.jsx), as a pure function over the facts it
 * reads, plus the phone's two extra rows.
 *
 * It decides what to render, never what to allow: every section's endpoint
 * answers 403 on its own.
 */

import { can, holds, type AccessSnapshot } from '@/core/access';

import { ORG_SECTIONS, type OrgSection, type OrgSectionId } from './sections';

export interface OrgVisibilityInputs {
    /** perms all|org_admin, or orgRole admin|org_admin (the server's org-admin test). */
    canSeeOrg: boolean;
    /** canSeeOrg, or the `manage_users` permission. */
    canManageUsers: boolean;
    /** `admin_compliance` and the `compliance_hub_gdpr` capability. */
    canSeeCompliance: boolean;
    /** The `learning_center` capability. */
    canUseLearning: boolean;
    /** The platform operator (perms `all` or role admin). */
    isSuperAdmin: boolean;
    isSelfHosted: boolean;
    /** The org was provisioned through Nextcloud (/auth/user `ncOrg`). */
    isNcOrg: boolean;
    /** This session came in through the Nextcloud connector. */
    isNcConnectorUser: boolean;
    /** The org already chose its sign-in method (a one-time choice). */
    authLocked: boolean;
    /** The caller connected GitHub (/api/integrations/github/status). */
    githubConnected: boolean;
}

type Rule = (i: OrgVisibilityInputs) => boolean;

/** Per-row rules, in the web's precedence; a row without one follows canSeeOrg. */
const RULES: Partial<Record<OrgSectionId, Rule>> = {
    org_compliance: (i) => i.canSeeCompliance,
    license: (i) => i.canSeeOrg && !i.isSelfHosted,
    org_users: (i) => i.canSeeOrg && i.canManageUsers,
    org_academy: (i) => i.canSeeOrg && i.canUseLearning,
    auth: (i) => i.canSeeOrg && !i.isNcOrg && !i.isNcConnectorUser && !i.authLocked,
    org_nextcloud_sync: (i) => i.canSeeOrg && (i.isNcOrg || i.isSuperAdmin),
    org_github_sync: (i) => i.canSeeOrg && i.githubConnected,
    org_azure: (i) => i.canSeeOrg && i.isSelfHosted,
};

export function isSectionVisible(id: OrgSectionId, inputs: OrgVisibilityInputs): boolean {
    const rule = RULES[id];
    return rule ? rule(inputs) : inputs.canSeeOrg;
}

export function visibleOrgSections(inputs: OrgVisibilityInputs): OrgSection[] {
    return ORG_SECTIONS.filter((section) => isSectionVisible(section.id, inputs));
}

/** The session facts `inputsFromAccess` needs beyond the access snapshot. */
export interface OrgSessionFacts {
    isNcOrg: boolean;
    provider: string | undefined;
    authLocked: boolean;
    githubConnected: boolean;
}

/**
 * The web's predicates over a core/access snapshot. `holds` counts `all`, and
 * the snapshot's isOrgAdmin is the server's requireOrgAdmin test, which is the
 * web's `canSeeOrg` with the super admin folded in.
 */
export function inputsFromAccess(snapshot: AccessSnapshot, facts: OrgSessionFacts): OrgVisibilityInputs {
    const canSeeOrg = snapshot.isOrgAdmin || holds(snapshot, 'org_admin');
    return {
        canSeeOrg,
        canManageUsers: canSeeOrg || holds(snapshot, 'manage_users'),
        canSeeCompliance: holds(snapshot, 'admin_compliance') && can(snapshot, 'compliance_hub_gdpr'),
        canUseLearning: can(snapshot, 'learning_center'),
        isSuperAdmin: snapshot.isSuperAdmin || holds(snapshot, 'all'),
        isSelfHosted: snapshot.mode === 'self-hosted',
        isNcOrg: facts.isNcOrg,
        isNcConnectorUser: facts.provider === 'nextcloud_connector',
        authLocked: facts.authLocked,
        githubConnected: facts.githubConnected,
    };
}
