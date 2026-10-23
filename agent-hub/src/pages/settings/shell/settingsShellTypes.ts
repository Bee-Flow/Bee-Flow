/** The signed-in person, as far as the settings shell reads them. */
export type SettingsUser = {
    permissions?: string[] | null;
    isAdmin?: boolean;
    orgRole?: string | null;
    role?: string;
    username?: string;
    displayName?: string;
    avatar?: string | null;
    avatarType?: string | null;
    simpleMode?: boolean;
    isConsumerAccount?: boolean;
    provider?: string;
    organizationId?: string;
    ncOrg?: { instanceId?: string } | null;
    featureFlags?: { deploymentMode?: string; projects?: boolean } | null;
    memoryEnabled?: boolean;
    orgMemoryEnabled?: boolean;
    sensitiveOptInAllowed?: boolean;
    memorySensitiveOptIn?: boolean;
    email?: string;
};

/** One row of the organisation sub-menu. */
export interface OrgSubItem {
    id: string;
    labelKey: string;
    icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
    color: string;
}

/** The integration and sign-in facts the shell fetches for its nav filters. */
export interface SettingsStatuses {
    githubConnected: boolean;
    [key: string]: unknown;
}
