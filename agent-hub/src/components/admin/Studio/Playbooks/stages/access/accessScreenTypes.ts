import type { AccessMember, AccessRole, AccessTableRule } from '../accessApply';

/** Who may open the app: only `groups` carries group ids and names. */
export type ScreenAudience =
    | { kind: 'groups'; groupIds: string[]; groupNames: string[] }
    | { kind: 'private' | 'organisation'; groupIds?: undefined; groupNames?: undefined };
export type AudienceKind = ScreenAudience['kind'];

/** The plan as the screen holds it: the hand-set and the proposed shape are the same. */
export interface ScreenPlan {
    audience: ScreenAudience | null;
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
    name?: string;
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
