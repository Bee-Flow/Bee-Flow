/** The icon at the start of an upload row: a spinner while it is on its way. */

import React from 'react';

import { useTheme } from '@/core/theme/ThemeProvider';
import { Icon, Spinner, type IconName } from '@/shared/ui';

import type { UploadItem } from '../hooks/useUploadQueue';

export function UploadStatusGlyph({ status }: { status: UploadItem['status'] }) {
    const theme = useTheme();
    if (status === 'uploading') return <Spinner />;
    const glyph = {
        queued: { name: 'Clock', color: theme.colors.textMuted },
        done: { name: 'CircleCheckBig', color: theme.colors.success },
        error: { name: 'CircleAlert', color: theme.colors.error },
        cancelled: { name: 'Ban', color: theme.colors.textMuted },
    }[status];
    return <Icon name={glyph.name as IconName} size={18} color={glyph.color} />;
}
