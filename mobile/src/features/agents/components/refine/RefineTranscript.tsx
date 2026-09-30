/**
 * The refine conversation: what the person asked, and after each ask either a
 * Done card or the reason it failed. While a refine is out the list ends in
 * "Updating…".
 */

import React from 'react';
import { FlatList, StyleSheet, View, type ListRenderItem } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { lastDoneIndex, type RefineTurn } from '@/features/agents/model/refineTurns';
import { Spinner, Text } from '@/shared/ui';

import { RefineDoneCard } from './RefineDoneCard';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        content: { padding: theme.spacing.lg, gap: theme.spacing.md },
        user: {
            alignSelf: 'flex-end',
            maxWidth: '85%',
            backgroundColor: theme.colors.userBubbleBg,
            borderRadius: theme.radii.xl,
            paddingHorizontal: theme.spacing.lg,
            paddingVertical: theme.spacing.sm,
        },
        userText: { color: theme.colors.userBubbleFg },
        busy: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
    });

type Styles = ReturnType<typeof makeStyles>;

export interface RefineTranscriptProps {
    turns: readonly RefineTurn[];
    busy: boolean;
    onTest: () => void;
    onUndo: (index: number, versionId: string) => void;
}

interface Row {
    turn: RefineTurn;
    index: number;
    superseded: boolean;
    styles: Styles;
    onTest: () => void;
    onUndo: (index: number, versionId: string) => void;
}

const renderRow: ListRenderItem<Row> = ({ item }) => {
    const { turn, styles } = item;
    if (turn.kind === 'user') {
        return (
            <View style={styles.user}>
                <Text variant="body" style={styles.userText}>
                    {turn.text}
                </Text>
            </View>
        );
    }
    if (turn.kind === 'error') {
        return (
            <Text variant="caption" tone="error">
                {turn.text}
            </Text>
        );
    }
    return (
        <RefineDoneCard
            turn={turn}
            superseded={item.superseded}
            onTest={item.onTest}
            onUndo={(versionId) => item.onUndo(item.index, versionId)}
        />
    );
};

const keyOf = (row: Row) => String(row.index);

export function RefineTranscript({ turns, busy, onTest, onUndo }: RefineTranscriptProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const newest = lastDoneIndex(turns);
    const rows: Row[] = turns.map((turn, index) => ({ turn, index, superseded: index !== newest, styles, onTest, onUndo }));
    return (
        <FlatList
            data={rows}
            renderItem={renderRow}
            keyExtractor={keyOf}
            contentContainerStyle={styles.content}
            keyboardShouldPersistTaps="handled"
            ListFooterComponent={
                busy ? (
                    <View style={styles.busy}>
                        <Spinner />
                        <Text variant="caption" tone="secondary">
                            {t('agent_wizard.builder.updating', 'Updating…')}
                        </Text>
                    </View>
                ) : null
            }
        />
    );
}
