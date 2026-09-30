/**
 * The phases in order — the web's PhaseRail as rows: a status glyph, the
 * phase's words, one fact from what it made, and how long it took. A row
 * opens what that phase did. A recipe has a handful of phases (the server
 * caps them), so this is a plain column, not a list that can grow.
 */

import React from 'react';
import { Pressable, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, Spinner, Text, type IconName } from '@/shared/ui';

import { phaseDuration, phaseFact, phaseLabel } from '../model/playbookView';
import type { Phase, PhaseStatus } from '../model/types';

const GLYPH: Record<PhaseStatus, IconName | null> = {
    done: 'CircleCheck',
    awaiting: 'Pause',
    failed: 'CircleX',
    skipped: 'CircleMinus',
    locked: 'Lock',
    running: null,
    ready: 'Circle',
    pending: 'Circle',
};

function PhaseRow({ phase, index, active, onOpen }: { phase: Phase; index: number; active: boolean; onOpen: (key: string) => void }) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const glyph = GLYPH[phase.status];
    const tint = phase.status === 'failed' ? theme.colors.errorInk : phase.status === 'done' ? theme.colors.successInk : theme.colors.textTertiary;
    const meta = [phaseFact(phase, t), phaseDuration(phase)].filter(Boolean).join(' · ');
    return (
        <Pressable
            onPress={() => onOpen(phase.key)}
            accessibilityRole="button"
            accessibilityHint={t('playbooks.rail.open_phase', 'Show what this phase did')}
            style={({ pressed }) => [styles.row, active ? styles.active : null, pressed ? styles.pressed : null]}
            testID={`playbook-phase-${phase.key}`}
        >
            {glyph ? <Icon name={glyph} size={18} color={tint} /> : <Spinner />}
            <View style={styles.body}>
                <Text variant="caption" weight={active ? 'semibold' : 'medium'}>
                    {`${index + 1}. ${phaseLabel(phase, t)}`}
                </Text>
                {meta ? (
                    <Text variant="label" tone="tertiary" numberOfLines={1}>
                        {meta}
                    </Text>
                ) : null}
            </View>
        </Pressable>
    );
}

export function PhaseList({ phases, activeKey, onOpen }: { phases: readonly Phase[]; activeKey: string | null; onOpen: (key: string) => void }) {
    const t = useTranslation();
    return (
        <View accessibilityLabel={t('playbooks.rail.aria', 'Phases')} testID="playbook-phases">
            {phases.map((phase, i) => (
                <PhaseRow key={phase.key} phase={phase} index={i} active={phase.key === activeKey} onOpen={onOpen} />
            ))}
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    row: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        gap: theme.spacing[3],
        minHeight: 52,
        paddingHorizontal: theme.spacing[3],
        paddingVertical: theme.spacing[2],
        borderRadius: theme.radii.sm,
    },
    active: { backgroundColor: theme.colors.itemActiveBg },
    pressed: { backgroundColor: theme.colors.itemHoverBg },
    body: { flex: 1, gap: theme.spacing[0.5] },
});
