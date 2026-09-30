/**
 * The frame every draft card shares (the web's DraftCardShell): a tinted
 * header saying where the draft stands, the draft itself, and — until it is
 * done, discarded or failed — the card's own actions beside Discard. A
 * failure keeps the server's reason on the card.
 */

import React, { type ReactNode } from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { DraftState } from '@/features/chat/hooks/useDraftAction';
import { Button, Icon, Text, tint, type IconName } from '@/shared/ui';


export type DraftTone = 'info' | 'success' | 'warning' | 'error' | 'muted';

const TONES: readonly DraftTone[] = ['info', 'success', 'warning', 'error', 'muted'];

function inkOf(theme: Theme, tone: DraftTone): string {
    return tone === 'muted' ? theme.colors.textTertiary : theme.colors[tone];
}

const makeStyles = (theme: Theme) => ({
    frame: Object.fromEntries(
        TONES.map((tone) => [tone, { borderColor: tint(inkOf(theme, tone), 40), backgroundColor: tint(inkOf(theme, tone), 5) }]),
    ) as Record<DraftTone, { borderColor: string; backgroundColor: string }>,
    ink: Object.fromEntries(TONES.map((tone) => [tone, { color: inkOf(theme, tone) }])) as Record<DraftTone, { color: string }>,
    card: { marginVertical: theme.spacing.md, borderRadius: theme.radii.lg, borderWidth: 1, overflow: 'hidden' as const },
    faded: { opacity: 0.5 },
    head: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: theme.spacing.sm, paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing[2.5] },
    body: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.md, gap: theme.spacing.sm },
    title: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: theme.spacing[2.5] },
    grow: { flex: 1 },
    foot: {
        flexDirection: 'row' as const,
        flexWrap: 'wrap' as const,
        gap: theme.spacing.sm,
        paddingHorizontal: theme.spacing.lg,
        paddingVertical: theme.spacing.md,
        borderTopWidth: 1,
        borderTopColor: theme.colors.borderSubtle,
        backgroundColor: theme.colors.bgSecondary,
    },
    error: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.md },
});

export interface DraftCardShellProps {
    state: DraftState & { discard: () => void };
    /** The header's words for the current state. */
    header: string;
    icon: IconName;
    /** The draft's own colour while it waits. */
    tone: DraftTone;
    title?: string;
    titleIcon?: IconName;
    children?: ReactNode;
    /** The card's confirm buttons; Discard is added here. */
    actions: ReactNode;
}

function toneOf(status: DraftState['status'], waiting: DraftTone): DraftTone {
    if (status === 'done') return 'success';
    if (status === 'failed') return 'error';
    return status === 'discarded' ? 'muted' : waiting;
}

export function DraftCardShell({ state, header, icon, tone, title, titleIcon, children, actions }: DraftCardShellProps) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const { status } = state;
    const resolved = status === 'done' || status === 'saved' || status === 'discarded' || status === 'failed';
    const busy = status === 'working' || status === 'saving';
    const shown = toneOf(status, tone);

    return (
        <View style={[styles.card, styles.frame[shown], status === 'discarded' ? styles.faded : null]}>
            <View style={styles.head}>
                <Icon name={icon} size={14} color={styles.ink[shown].color} />
                <Text variant="label" weight="semibold" style={[styles.grow, styles.ink[shown]]}>
                    {header.toUpperCase()}
                </Text>
            </View>
            <View style={styles.body}>
                {title ? (
                    <View style={styles.title}>
                        {titleIcon ? <Icon name={titleIcon} size={16} color={theme.colors.textTertiary} /> : null}
                        <Text variant="body" weight="semibold" style={styles.grow}>
                            {title}
                        </Text>
                    </View>
                ) : null}
                {children}
            </View>
            {status === 'failed' && state.error ? (
                <Text variant="caption" tone="error" style={styles.error}>
                    {t('chat.draft.error', 'Error: {reason}', { reason: state.error })}
                </Text>
            ) : null}
            {resolved ? null : (
                <View style={styles.foot}>
                    {actions}
                    <Button label={t('chat.draft.discard', 'Discard')} iconName="X" variant="ghost" size="sm" disabled={busy} onPress={state.discard} />
                </View>
            )}
        </View>
    );
}
