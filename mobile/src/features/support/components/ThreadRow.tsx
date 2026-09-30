/** One of your requests: its subject, where it stands, and when it last moved. */

import React from 'react';

import { timeAgo, useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Badge, Icon, ListRow } from '@/shared/ui';

import { isFinished, statusCopy } from '../model/status';
import type { SupportThread } from '../model/types';

export function ThreadRow({ thread, onOpen }: { thread: SupportThread; onOpen: () => void }) {
    useTranslation(); // re-render when the language changes: timeAgo speaks it
    const theme = useTheme();
    const status = statusCopy(thread.status);
    return (
        <ListRow
            title={thread.subject}
            subtitle={`${status.label} · ${timeAgo(thread.last_message_at ?? thread.created_at)}`}
            wrapTitle
            onPress={onOpen}
            leading={
                <Icon
                    name={isFinished(thread.status) ? 'CircleCheckBig' : 'MessageCircle'}
                    size={16}
                    color={thread.status === 'resolved' ? theme.colors.success : theme.colors.textMuted}
                />
            }
            trailing={<Badge label={status.label} tone={status.tone} />}
        />
    );
}
