/**
 * One knowledge source: its kind, its name, how far the server got reading
 * it, and a tap for what can still be done with it.
 */

import React from 'react';

import { useTheme } from '@/core/theme/ThemeProvider';
import { Badge, Icon, ListRow } from '@/shared/ui';

import type { WebpageSource } from '../model/buildTypes';
import { sourceDetail, sourceIcon, sourceKindLabel, sourceStatus } from '../model/sources';

export function SourceRow({ source, onPress }: { source: WebpageSource; onPress: (source: WebpageSource) => void }) {
    const theme = useTheme();
    const status = sourceStatus(source);
    const detail = sourceDetail(source);
    return (
        <ListRow
            title={source.name}
            subtitle={detail ? `${sourceKindLabel(source)} · ${detail}` : sourceKindLabel(source)}
            leading={<Icon name={sourceIcon(source)} size={20} color={theme.colors.textSecondary} />}
            trailing={<Badge label={status.label} tone={status.tone} />}
            onPress={() => onPress(source)}
        />
    );
}
