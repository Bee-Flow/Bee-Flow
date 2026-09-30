/**
 * The last few runs of one routine, with a way into the full history. Bounded
 * by the query (six rows), so a plain map inside the card is fine.
 */

import { useRouter } from 'expo-router';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Banner, Button, Card, Divider, Section, Spinner, Text } from '@/shared/ui';

import { RunRow } from './RunRow';
import type { AutomationRun } from '../model/types';

const makeStyles = (theme: Theme) => StyleSheet.create({ padded: { padding: theme.spacing.lg } });

interface RunsQuery {
    data: AutomationRun[] | undefined;
    isLoading: boolean;
    isError: boolean;
    error: unknown;
    refetch: () => unknown;
}

function RunsBody({ automationId, runs }: { automationId: string; runs: RunsQuery }) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const router = useRouter();

    if (runs.isLoading) {
        return (
            <View style={styles.padded}>
                <Spinner />
            </View>
        );
    }
    if (runs.isError) {
        return (
            <View style={styles.padded}>
                <Banner
                    tone="error"
                    action={<Button label="Retry" variant="ghost" onPress={() => void runs.refetch()} />}
                >
                    {describeError(runs.error).message}
                </Banner>
            </View>
        );
    }
    if ((runs.data ?? []).length === 0) {
        return (
            <View style={styles.padded}>
                <Text variant="body" tone="tertiary">
                    This automation has never run. Press “Run now” to try it — a
                    manual run does everything a real one does.
                </Text>
            </View>
        );
    }
    return (
        <>
            {(runs.data ?? []).map((run, index) => (
                <View key={run.id}>
                    {index > 0 ? <Divider inset={theme.spacing.lg} /> : null}
                    <RunRow
                        run={run}
                        onPress={() => router.push(`/automations/${automationId}/runs?runId=${run.id}`)}
                    />
                </View>
            ))}
        </>
    );
}

export function RecentRunsSection({ automationId, runs }: { automationId: string; runs: RunsQuery }) {
    const router = useRouter();
    return (
        <Section
            title="Recent runs"
            action={
                <Button
                    label="See all"
                    variant="ghost"
                    onPress={() => router.push(`/automations/${automationId}/runs`)}
                />
            }
        >
            <Card padded={false}>
                <RunsBody automationId={automationId} runs={runs} />
            </Card>
        </Section>
    );
}
