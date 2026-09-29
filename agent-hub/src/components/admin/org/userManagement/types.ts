/**
 * Shapes shared by the platform console's hooks and presentation components.
 * This screen (UserManagement) is the platform-wide directory — every user,
 * group, role and organisation across every tenant — not the org-scoped
 * membership screen (OrgUsersPanel, its own `useOrg*` hooks and types live
 * one level up). The two share three tab names and two endpoints; nothing
 * else, so nothing here reuses those.
 */

/** One row, as GET /auth/users returns it. Only what this screen reads is
 * named; the server owns the rest. */
export interface AdminUser {
    id: string;
    username?: string;
    displayName?: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    avatar?: string;
    avatarType?: string;
    password?: string;
    role?: string;
    groups?: string[];
    organizationId?: string;
    orgRole?: string;
    isSystem?: boolean;
    [key: string]: unknown;
}

/** One row, as GET /auth/groups returns it. */
export interface AdminGroup {
    id: string;
    name?: string;
    description?: string;
    permissions?: string[];
    roles?: string[];
    organizationId?: string;
    allowedAgentTypes?: string[];
    [key: string]: unknown;
}

/** One row, as GET /auth/roles returns it (the install-wide SYSTEM role
 * table — unrelated to an organisation's own roles). */
export interface AdminRole {
    id: string;
    name?: string;
    description?: string;
    permissions?: string[];
    [key: string]: unknown;
}

/** One row, as GET /auth/permissions returns it. `group` is the field name
 * the server uses (server/auth/permissions.js) to bucket pages/admin/actions/super. */
export interface AdminPermission {
    id: string;
    name?: string;
    description?: string;
    group?: string;
    [key: string]: unknown;
}

/** One row, as GET /auth/organizations returns it. */
export interface AdminOrganization {
    id: string;
    name?: string;
    description?: string;
    tagline?: string;
    address?: string;
    email?: string;
    phone?: string;
    website?: string;
    kvk?: string;
    vat?: string;
    logo?: string;
    footerText?: string;
    defaultGroups?: string[];
    allowSignup?: boolean;
    registrationSource?: string;
    nc_instance_id?: string;
    nc_base_url?: string;
    nc_provisioned_at?: string;
    [key: string]: unknown;
}

/** The caller — enough of `user` to gate actions and pre-fill "my organisation". */
export interface AdminCurrentUser {
    id?: string;
    permissions?: string[];
    isAdmin?: boolean;
    role?: string;
    organizations?: string[];
    [key: string]: unknown;
}

/** Status line above the tab bar; `text` can be a server error payload that
 * isn't a string, which the renderer JSON.stringifies. */
export interface AdminMessage {
    type: 'success' | 'error';
    text: unknown;
}

export interface UserFormData {
    id: string;
    username: string;
    displayName: string;
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    avatar: string;
    avatarType: string;
    password: string;
    role: string;
    groups: string[];
    organizationId: string;
    orgRole: string;
}

export interface OrgFormData {
    id: string;
    name: string;
    description: string;
    tagline: string;
    address: string;
    email: string;
    phone: string;
    website: string;
    kvk: string;
    vat: string;
    logo: string;
    footerText: string;
    defaultGroups: string[];
    allowSignup: boolean;
    enabledIntegrations?: string[] | null;
    _logoFile?: File | null;
}

export interface GroupFormData {
    id: string;
    name: string;
    description: string;
    permissions: string[];
    roles: string[];
    organizationId: string;
    allowedAgentTypes: string[];
}

export interface RoleFormData {
    id: string;
    name: string;
    description: string;
    permissions: string[];
}

/**
 * Destructive actions route through <ConfirmDialog/>, never window.confirm:
 * `askConfirm` just sets state for the dialog to render — there is no
 * promise to await, unlike the org-scoped hooks' `confirm`.
 */
export interface ConfirmOptions {
    title: string;
    description?: string;
    confirmLabel?: string;
    destructive?: boolean;
    onConfirm: () => void | Promise<void>;
}

export type AskConfirm = (opts: ConfirmOptions) => void;
