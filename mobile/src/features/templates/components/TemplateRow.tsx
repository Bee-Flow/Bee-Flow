/** One template: tap for its placeholders, hold to delete. */

import React from 'react';

import { timeAgo, useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { plural } from '@/shared/lib/format';
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
    useTranslation(); // re-render when the language changes: timeAgo speaks it
    const theme = useTheme();
    const fields = template.parameters.length;
    return (
        <ListRow
            title={template.name}
            subtitle={template.description || template.fileName || undefined}
            meta={timeAgo(template.updatedAt ?? template.createdAt)}
            wrapTitle
            leading={<Icon name="PanelsTopLeft" size={18} color={theme.colors.textMuted} />}
            trailing={<Badge label={plural(fields, 'field')} tone={fields > 0 ? 'accent' : 'neutral'} />}
            onPress={onPress}
            onLongPress={onLongPress}
        />
    );
}
