/** One approval in the inbox: the question, where it came from, and its state. */

import React from 'react';

import { timeAgo, useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Badge, Icon, ListRow } from '@/shared/ui';

import { approvalStatusLabel } from '../model/status';
import type { Approval } from '../model/types';

type Glyph = { name: 'Clock' | 'Check' | 'X'; tone: 'warning' | 'success' | 'textMuted' };

function glyphFor(status: Approval['status']): Glyph {
    if (status === 'pending') return { name: 'Clock', tone: 'warning' };
    if (status === 'approved') return { name: 'Check', tone: 'success' };
    return { name: 'X', tone: 'textMuted' };
}

export function ApprovalRow({ approval, onPress }: { approval: Approval; onPress: () => void }) {
    const t = useTranslation();
    const theme = useTheme();
    const glyph = glyphFor(approval.status);
    return (
        <ListRow
            title={approval.prompt}
            wrapTitle
            subtitle={approval.automationTitle || approval.projectTitle || undefined}
            meta={timeAgo(approval.decidedAt ?? approval.createdAt)}
            leading={<Icon name={glyph.name} size={16} color={theme.colors[glyph.tone]} />}
            trailing={approval.status !== 'pending' ? <Badge label={approvalStatusLabel(approval.status, t)} tone="neutral" /> : undefined}
            onPress={onPress}
        />
    );
}
