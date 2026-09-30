/**
 * Summary templates: the saved "Regenerate" prompts of Meeting Notes.
 *
 * Traced to server/routes/summaryTemplates.js (the route) and `mapRow` in
 * server/stores/summaryTemplateStore.js (a custom row). A built-in has only
 * `id`, `name`, `nameKey` and `prompt` (BUILTIN_TEMPLATES).
 */

/** Who sees a template. Fixed at creation: the route has no way to move one. */
export type TemplateScope = 'user' | 'org' | 'group';

export const TEMPLATE_SCOPES: readonly TemplateScope[] = ['user', 'org', 'group'];

export interface SummaryTemplate {
    id: string;
    name: string;
    prompt?: string;
    /** A built-in's catalogue key for its name. */
    nameKey?: string;
    scope?: TemplateScope;
    groupId?: string | null;
    isDefault?: boolean;
}

/** `GET /api/summary-templates`. */
export interface SummaryTemplates {
    builtins: SummaryTemplate[];
    /** Every custom template the caller can see: their own, their org's, their groups'. */
    custom: SummaryTemplate[];
    defaultTemplateId: string | null;
    /** Org admin of the primary org: may create org and group templates. */
    canManageOrg: boolean;
}

/** One of the org's groups, from `GET /api/summary-templates/org` (admins only). */
export interface TemplateGroup {
    id: string;
    name: string;
}

/** `GET /api/summary-templates/org` (admins only). */
export interface OrgTemplates {
    /** Every org and group template of the org, also of groups the admin is not in. */
    templates: SummaryTemplate[];
    groups: TemplateGroup[];
}

/** A list row: the template, and whether this person may save or delete it. */
export interface TemplateListRow {
    template: SummaryTemplate;
    editable: boolean;
}

/** What the editor holds. `groupId` matters only for scope 'group'. */
export type TemplateDraft = {
    name: string;
    prompt: string;
    scope: TemplateScope;
    groupId: string;
    isDefault: boolean;
};
