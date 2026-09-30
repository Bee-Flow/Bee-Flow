/**
 * "How things stand": every row derived (model/posture.ts), none a second
 * home for a setting — a row opens the tab that owns its control.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Group, Icon, NavRow, NoteRow, Text } from '@/shared/ui';

import type { Posture, PostureRow, PostureTab } from '../model/posture';
import { postureHint, postureLabel, postureValue } from '../model/postureText';

function Row({ row, onGoTo }: { row: PostureRow; onGoTo: (tab: PostureTab) => void }) {
    const t = useTranslation();
    const theme = useTheme();
    const flagged = row.tone === 'warn' || row.tone === 'error';
    const hint = postureHint(row, t);
    const value = postureValue(row, t);
    const tab = row.tab;
    return (
        <NavRow
            label={postureLabel(row.id, t)}
            description={hint ? `${value} · ${hint}` : value}
            icon={flagged ? 'TriangleAlert' : 'Check'}
            iconColor={flagged ? theme.colors.warningInk : theme.colors.textTertiary}
            onPress={() => (tab ? onGoTo(tab) : undefined)}
            trailing={tab ? <Icon name="ChevronRight" size={16} color={theme.colors.textTertiary} /> : undefined}
            testID={`posture-${row.id}`}
        />
    );
}

export function PostureGroup({ posture, onGoTo }: { posture: Posture; onGoTo: (tab: PostureTab) => void }) {
    const t = useTranslation();
    if (posture.off) {
        return (
            <Group>
                <NoteRow>
                    <Text variant="caption" tone="secondary">
                        {t('admin.shield_disabled_note_steps', 'Protection is off for this organisation. Messages go to the AI unchanged, and the other steps stay inactive until you turn it on.')}
                    </Text>
                </NoteRow>
            </Group>
        );
    }
    return (
        <Group
            title={t('admin.shield_posture_title', 'How things stand')}
            footer={
                posture.attention > 0
                    ? t('admin.shield_posture_attention', '{n} need attention', { n: posture.attention })
                    : t('admin.shield_summary_all_clear', 'all clear')
            }
        >
            {posture.rows.map((row) => (
                <Row key={row.id} row={row} onGoTo={onGoTo} />
            ))}
        </Group>
    );
}
