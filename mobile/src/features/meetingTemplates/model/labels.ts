/** Words for a template's scope, on the web's keys (agent-hub TemplateManager.jsx). */

import type { TranslateFn } from '@/core/i18n';

import type { SummaryTemplate, TemplateGroup, TemplateScope } from './types';

export function scopeLabel(scope: TemplateScope | undefined, t: TranslateFn): string {
    if (scope === 'org') return t('meeting_notes.template_scope_org', 'Whole organization');
    if (scope === 'group') return t('meeting_notes.template_scope_group', 'Specific group');
    return t('meeting_notes.template_scope_user', 'Just me');
}

/** A group template is labelled with its group's name when the caller can see the groups. */
export function templateScopeText(
    template: SummaryTemplate,
    groups: readonly TemplateGroup[],
    t: TranslateFn,
): string {
    if (template.scope === 'group') {
        const group = groups.find((g) => g.id === template.groupId);
        if (group) return group.name;
    }
    return scopeLabel(template.scope, t);
}
