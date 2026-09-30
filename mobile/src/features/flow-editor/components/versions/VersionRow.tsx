/**
 * One saved version in the history — the web Versions tab's row (handoff 5):
 * `v12`, its milestone name or what the save changed, "editing" on the
 * working copy, "live since …" on the live one, a flag on a milestone, and
 * when, by whom and how its runs went. Tap it to compare; the restore glyph
 * restores it.
 */

import React from 'react';
import { Pressable, View, type TextStyle, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { FlowVersionSummary } from '@/features/flow-editor/api';
import { Badge, Icon, IconButton, Text } from '@/shared/ui';

import { shortWhen, versionMeta, versionTitle } from './versionText';

const makeStyles = (theme: Theme) => ({
    row: {
        flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md,
        paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.sm, minHeight: theme.minTouch,
    } satisfies ViewStyle,
    pressed: { backgroundColor: theme.colors.itemHoverBg } satisfies ViewStyle,
    number: { width: 44 } satisfies TextStyle,
    body: { flex: 1, gap: 2 } satisfies ViewStyle,
    line: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs } satisfies ViewStyle,
    title: { flexShrink: 1 } satisfies TextStyle,
    glyph: { color: theme.colors.textTertiary },
    milestone: { color: theme.stepType.branch },
});

export interface VersionRowProps {
    version: FlowVersionSummary;
    current: boolean;
    restoring: boolean;
    onOpen: (version: FlowVersionSummary) => void;
    onRestore: (version: FlowVersionSummary) => void;
}

export function VersionRow({ version, current, restoring, onOpen, onRestore }: VersionRowProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const liveSince = shortWhen(version.liveSince, t);
    return (
        <Pressable
            onPress={() => onOpen(version)}
            accessibilityRole="button"
            accessibilityHint={t('mobile.flow.versions.open_hint', 'Shows what changed in this version')}
            style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}
            testID={`version-${version.id}`}
        >
            <Text variant="code" style={styles.number}>{`v${version.version}`}</Text>
            <View style={styles.body}>
                <View style={styles.line}>
                    <Text variant="body" tone="secondary" numberOfLines={1} style={styles.title}>
                        {versionTitle(version, t)}
                    </Text>
                    {version.isEditing || current ? <Badge label={t('routines.versions.chip.editing', 'editing')} tone="neutral" /> : null}
                    {version.isLive ? (
                        <Badge
                            label={liveSince ? t('routines.versions.chip.liveSince', 'live since {date}', { date: liveSince }) : t('routines.versions.chip.live', 'live')}
                            tone="success"
                        />
                    ) : null}
                    {version.name ? (
                        <View accessible accessibilityLabel={t('routines.versions.milestone', 'Milestone')}>
                            <Icon name="Flag" size={12} color={styles.milestone.color} />
                        </View>
                    ) : null}
                </View>
                <Text variant="caption" tone="tertiary" numberOfLines={1}>{versionMeta(version, t)}</Text>
            </View>
            {current || version.isEditing ? null : (
                <IconButton
                    icon={<Icon name="RotateCcw" size={18} color={styles.glyph.color} />}
                    accessibilityLabel={t('mobile.flow.versions.restore_this', 'Restore this version')}
                    onPress={() => onRestore(version)}
                    disabled={restoring}
                    testID={`restore-${version.id}`}
                />
            )}
        </Pressable>
    );
}
