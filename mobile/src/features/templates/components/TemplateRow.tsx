/** One template: tap for its placeholders, hold to delete. */

import React from 'react';

import { timeAgo, useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { nOf } from '@/shared/lib/plural';
import { Badge, Icon, ListRow } from '@/shared/ui';

import type { Template } from '../model/types';

export function TemplateRow({
    template,
    onPress,
    onLongPress,
}: {
    template: Template;
    onPress: () => void;
    onLongPress: () => void;
}) {
    const t = useTranslation(); // also re-renders when the language changes: timeAgo speaks it
    const theme = useTheme();
    const fields = template.parameters.length;
    return (
        <ListRow
            title={template.name}
            subtitle={template.description || template.fileName || undefined}
            meta={timeAgo(template.updatedAt ?? template.createdAt)}
            wrapTitle
            leading={<Icon name="PanelsTopLeft" size={18} color={theme.colors.textMuted} />}
            trailing={<Badge label={nOf(t, 'mobile.templates.n_fields', fields, ['{count} field', '{count} fields'])} tone={fields > 0 ? 'accent' : 'neutral'} />}
            onPress={onPress}
            onLongPress={onLongPress}
        />
    );
}
