/**
 * Contract readers for /api/summary-templates (server/routes/summaryTemplates.js).
 * A custom row is `mapRow` in server/stores/summaryTemplateStore.js; a built-in
 * is `{ id, name, nameKey, prompt }` from BUILTIN_TEMPLATES.
 */

import { field, pick, shapeListOf, shapeOf } from '@/core/api/contract';

import { TEMPLATE_SCOPES, type OrgTemplates, type SummaryTemplates, type TemplateGroup } from '../model/types';

const TEMPLATE_SPEC = {
    id: field.str(''),
    name: field.str(''),
    prompt: field.optStr,
    nameKey: field.optStr,
    scope: field.optOneOf(TEMPLATE_SCOPES),
    groupId: field.strOrNull,
    isDefault: field.optBool,
};

export const readTemplate = shapeOf(TEMPLATE_SPEC);

export const readSummaryTemplates: (raw: unknown) => SummaryTemplates = shapeOf({
    builtins: field.list(readTemplate),
    custom: field.list(readTemplate),
    defaultTemplateId: field.strOrNull,
    canManageOrg: field.bool(false),
});

const readGroups: (raw: unknown) => TemplateGroup[] = shapeListOf({ id: field.str(''), name: field.str('') });

const readTemplates = shapeListOf(TEMPLATE_SPEC);

/**
 * `GET /org` answers `{ orgId, templates, groups }`: every org and group
 * template of the org (also groups the admin is not in), and its groups.
 */
export function readOrgTemplates(raw: unknown): OrgTemplates {
    return {
        templates: readTemplates(pick(raw, 'templates')).filter((tpl) => tpl.id),
        groups: readGroups(pick(raw, 'groups')).filter((g) => g.id),
    };
}
