/**
 * The node editor's header — ObjectHeader's recipe (shared/ui) with what a
 * STEP needs that a Studio object does not: its family tile instead of a kind
 * tile, the web's kicker ("AI STEP · Step 3 of 7") over the name, and paging
 * to the previous and next step in RUN order right beside the name (the web
 * put it there twice, after testers could not find it among the window
 * controls — BFSF-332). The name is a button: it opens the rename field under
 * the header. "Test step" is the one primary action; the save state is its
 * quiet neighbour.
 */

import { useRouter } from 'expo-router';
import React, { type ReactNode } from 'react';
import { Pressable, View, type TextStyle, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { FlowNode } from '@/features/flow-editor/bindings';
import { stepFamily, familyColor, type FlowPosition } from '@/features/flow-editor/model';
import { Icon, IconButton, Spinner, Text } from '@/shared/ui';

import { FamilyTile } from './FamilyTile';

export interface StepHeaderProps {
    step: FlowNode;
    title: string;
    kicker: string;
    position: FlowPosition;
    onPage: (stepId: string) => void;
    onRename: () => void;
    onTest: () => void;
    testing: boolean;
    canTest: boolean;
    status?: ReactNode;
}

type Styles = ReturnType<typeof makeStyles>;

function Paging({ position, onPage, styles }: { position: FlowPosition; onPage: (id: string) => void; styles: Styles }) {
    const t = useTranslation();
    if (position.total <= 1) return null;
    const glyph = (on: boolean) => (on ? styles.glyph.color : styles.dim.color);
    return (
        <View style={styles.paging}>
            <IconButton
                icon={<Icon name="ChevronUp" size={18} color={glyph(!!position.prevId)} />}
                accessibilityLabel={t('routines.ndv.prev_step', 'Previous step')}
                disabled={!position.prevId}
                onPress={() => position.prevId && onPage(position.prevId)}
                testID="step-prev"
            />
            <IconButton
                icon={<Icon name="ChevronDown" size={18} color={glyph(!!position.nextId)} />}
                accessibilityLabel={t('routines.ndv.next_step', 'Next step')}
                disabled={!position.nextId}
                onPress={() => position.nextId && onPage(position.nextId)}
                testID="step-next"
            />
        </View>
    );
}

export function StepHeader({ step, title, kicker, position, onPage, onRename, onTest, testing, canTest, status }: StepHeaderProps) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const router = useRouter();
    const theme = useTheme();
    const kickerColor: TextStyle = { color: familyColor(theme, stepFamily(step.type)) };
    return (
        <View style={styles.row}>
            <IconButton
                icon={<Icon name="ArrowLeft" size={20} color={styles.glyph.color} />}
                accessibilityLabel={t('common.back', 'Back')}
                onPress={() => router.back()}
            />
            <FamilyTile step={step} />
            <Pressable
                style={styles.titles}
                onPress={onRename}
                accessibilityRole="button"
                accessibilityLabel={title}
                accessibilityHint={t('mobile.flow.ndv.rename_hint', 'Rename this step')}
                testID="step-title"
            >
                <Text variant="label" weight="semibold" style={[styles.kicker, kickerColor]} numberOfLines={1}>
                    {kicker}
                </Text>
                <Text variant="subheading" style={styles.name} numberOfLines={1} accessibilityRole="header">
                    {title}
                </Text>
                {status}
            </Pressable>
            <Paging position={position} onPage={onPage} styles={styles} />
            {canTest ? (
                testing ? (
                    <View style={styles.spinner}>
                        <Spinner />
                    </View>
                ) : (
                    <IconButton
                        icon={<Icon name="Play" size={18} color={styles.accent.color} />}
                        accessibilityLabel={t('routines.ndv.test_step', 'Test step')}
                        accessibilityHint={t('routines.ndv.execute_title', 'Execute this step only (uses upstream replay / pinned data)')}
                        onPress={onTest}
                        testID="step-test"
                    />
                )
            ) : null}
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing[1.5],
        minHeight: 60,
        paddingLeft: theme.spacing[1],
        paddingRight: theme.spacing[1],
        paddingVertical: theme.spacing[1],
    } satisfies ViewStyle,
    titles: { flex: 1, minWidth: 0, paddingLeft: theme.spacing[1] } satisfies ViewStyle,
    kicker: { textTransform: 'uppercase', letterSpacing: 0.6 } satisfies TextStyle,
    name: { fontSize: 16, lineHeight: 22 } satisfies TextStyle,
    paging: { flexDirection: 'row' } satisfies ViewStyle,
    spinner: { width: 48, alignItems: 'center' } satisfies ViewStyle,
    glyph: { color: theme.colors.textSecondary },
    dim: { color: theme.colors.textTertiary },
    accent: { color: theme.colors.accentText },
});
