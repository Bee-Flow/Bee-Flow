/**
 * The one thing a run's state lets you do: decide the step it waits on, stop
 * it while it moves, or run it again once it has settled.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button } from '@/shared/ui';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        pair: { flexDirection: 'row', gap: theme.spacing.sm },
        half: { flex: 1 },
    });

interface Action<T = void> {
    run: (value: T) => void;
    pending: boolean;
}

export function RunActions({
    awaitingApproval,
    live,
    decide,
    stop,
    retry,
}: {
    awaitingApproval: boolean;
    live: boolean;
    decide: Action<'approve' | 'reject'>;
    stop: Action;
    retry: Action;
}) {
    const styles = useThemedStyles(makeStyles);
    if (awaitingApproval) {
        return (
            <View style={styles.pair}>
                <Button
                    label="Approve"
                    onPress={() => decide.run('approve')}
                    loading={decide.pending}
                    style={styles.half}
                />
                <Button
                    label="Reject"
                    variant="danger"
                    onPress={() => decide.run('reject')}
                    disabled={decide.pending}
                    style={styles.half}
                />
            </View>
        );
    }
    if (live) {
        return (
            <Button
                label="Stop this run"
                variant="danger"
                fullWidth
                loading={stop.pending}
                onPress={() => stop.run()}
            />
        );
    }
    return (
        <Button
            label="Run it again"
            variant="secondary"
            fullWidth
            loading={retry.pending}
            onPress={() => retry.run()}
            accessibilityHint="Replays this run with the same trigger data"
        />
    );
}
