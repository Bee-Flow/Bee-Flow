/**
 * The template editor's pure rules, mirroring agent-hub TemplateEditor.jsx and
 * the `.strict()` bodies in server/routes/summaryTemplates.js.
 */

import type { SummaryTemplate, TemplateDraft, TemplateListRow, TemplateScope } from './types';

/** The route's caps (MAX_NAME_LEN, MAX_PROMPT_LEN); it refuses rather than cuts. */
export const MAX_NAME_LENGTH = 120;
export const MAX_PROMPT_LENGTH = 20_000;

/**
 * A fresh draft. Personal settings start where the web's do, on "Just me";
 * the org admin's panel starts on the organisation (TemplateManager's
 * `defaultScope`).
 */
export function emptyDraft(scope: TemplateScope = 'user'): TemplateDraft {
    return { name: '', prompt: '', scope, groupId: '', isDefault: false };
}

export function draftFrom(template: SummaryTemplate): TemplateDraft {
    return {
        name: template.name,
        prompt: template.prompt ?? '',
        scope: template.scope ?? 'user',
        groupId: template.groupId ?? '',
        isDefault: Boolean(template.isDefault),
    };
}

/** The scopes this person may pick. Org and group need an org admin. */
export function scopesFor(canManageOrg: boolean): TemplateScope[] {
    return canManageOrg ? ['user', 'org', 'group'] : ['user'];
}

/** A group template without its group is a 400; the button stays off instead. */
export function draftReady(draft: TemplateDraft): boolean {
    return Boolean(draft.name.trim() && draft.prompt.trim()) && (draft.scope !== 'group' || Boolean(draft.groupId));
}

/**
 * The POST body. `groupId` travels ONLY with scope 'group': the route refuses
 * it anywhere else, because an org-wide template naming one group used to be
 * created silently org-wide.
 */
export function createBody(draft: TemplateDraft) {
    return {
        scope: draft.scope,
        name: draft.name.trim(),
        prompt: draft.prompt.trim(),
        isDefault: draft.isDefault,
        ...(draft.scope === 'group' ? { groupId: draft.groupId } : {}),
    };
}

/** The PATCH body. Scope and group are fixed after creation. */
export function patchBody(draft: TemplateDraft) {
    return { name: draft.name.trim(), prompt: draft.prompt.trim(), isDefault: draft.isDefault };
}

/** "Start from a built-in": its prompt, and its name only while the name is blank. */
export function seedDraft(draft: TemplateDraft, builtin: SummaryTemplate): TemplateDraft {
    return { ...draft, prompt: builtin.prompt ?? '', name: draft.name.trim() ? draft.name : builtin.name };
}

/** Custom templates, the caller's default first, then by name. */
export function sortTemplates(templates: readonly SummaryTemplate[]): SummaryTemplate[] {
    return [...templates].sort(
        (a, b) => Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)) || a.name.localeCompare(b.name),
    );
}

/**
 * The screen's rows. `custom` (GET /) holds every template the caller can
 * SEE, but only their personal ones are theirs to write; an org or group
 * template is written by an org admin (the route's `authorizeWrite`). So:
 * personal rows are editable; for an admin, `org` (GET /org, null for anyone
 * else) adds the org's templates as editable, also of groups they are not in;
 * whatever is left is shown read-only.
 */
export function templateRows(
    custom: readonly SummaryTemplate[],
    org: readonly SummaryTemplate[] | null,
): TemplateListRow[] {
    const managed = new Set((org ?? []).map((tpl) => tpl.id));
    const personal = custom.filter((tpl) => (tpl.scope ?? 'user') === 'user');
    const shared = custom.filter((tpl) => (tpl.scope ?? 'user') !== 'user' && !managed.has(tpl.id));
    return [
        ...sortTemplates(personal).map((template) => ({ template, editable: true })),
        ...sortTemplates(org ?? []).map((template) => ({ template, editable: true })),
        ...sortTemplates(shared).map((template) => ({ template, editable: false })),
    ];
}
