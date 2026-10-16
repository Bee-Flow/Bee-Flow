import type { AccessAudience, AccessMember, AccessRole, AccessTableRule } from '../accessApply';

/** The plan as the screen holds it: the hand-set and the proposed shape are the same. */
export interface ScreenPlan {
    audience: AccessAudience | null;
    roles: AccessRole[];
    tableRules?: AccessTableRule[];
    byGroup: Record<string, string>;
    members: AccessMember[];
    unresolved?: { kind: string; name: string }[];
    note?: string;
    nextcloudMenu?: boolean;
    empty?: boolean;
}

export interface DirectoryGroup {
    id: string;
    name: string;
}

export interface DirectoryUser {
    id: string;
    name?: string;
    email?: string;
}

export interface RoleOption {
    key: string;
    label: string;
}
