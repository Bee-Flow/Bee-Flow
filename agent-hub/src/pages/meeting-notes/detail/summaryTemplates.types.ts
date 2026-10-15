/** Summary templates as GET /api/summary-templates sends them (server/routes/summaryTemplates.js). */

/** A built-in template; they live in server code, so there is no version or owner. */
export interface BuiltinTemplate {
    id: string;
    name: string;
    /** Absent on the client-side fallback list used before the server answers. */
    nameKey?: string;
    prompt?: string;
}

interface CustomTemplateBase {
    id: string;
    name: string;
    prompt: string;
    isDefault: boolean;
    version: number | null;
}

/** A saved template. `groupId` is set exactly when `scope` is 'group'. */
export type CustomTemplate =
    | (CustomTemplateBase & { scope: 'user'; groupId: null })
    | (CustomTemplateBase & { scope: 'org'; groupId: null })
    | (CustomTemplateBase & { scope: 'group'; groupId: string });

export interface SummaryTemplates {
    builtins?: BuiltinTemplate[];
    custom?: CustomTemplate[];
    defaultTemplateId?: string | null;
    canManageOrg?: boolean;
    primaryOrgId?: string | null;
}

/** A group a template can be scoped to (GET /auth/groups). */
export interface OrgGroup {
    id: string;
    name: string;
}
