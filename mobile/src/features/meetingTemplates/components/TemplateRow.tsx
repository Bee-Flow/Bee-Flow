/**
 * One custom template: scope glyph, name, who sees it, and the Default mark.
 * Without `onPress` it is read-only: a template this person may not write.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Badge, Icon, ListRow, type IconName } from '@/shared/ui';

import { templateScopeText } from '../model/labels';
import type { SummaryTemplate, TemplateGroup, TemplateScope } from '../model/types';

const SCOPE_ICON: Record<TemplateScope, IconName> = { user: 'User', org: 'Building2', group: 'Users' };

export function TemplateRow({
    template,
    groups,
    onPress,
}: {
    template: SummaryTemplate;
    groups: readonly TemplateGroup[];
    onPress?: () => void;
}) {
    const t = useTranslation();
    const theme = useTheme();
    return (
        <ListRow
            title={template.name}
            subtitle={templateScopeText(template, groups, t)}
            onPress={onPress}
            leading={<Icon name={SCOPE_ICON[template.scope ?? 'user']} size={18} color={theme.colors.textTertiary} />}
            trailing={
                template.isDefault ? (
                    <Badge label={t('meeting_notes.template_default_badge', 'Default')} tone="accent" icon="Star" />
                ) : undefined
            }
        />
    );
}
