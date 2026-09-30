/**
 * "Step by step": the run's journey as a timeline, or why it could not be read.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Banner, Button, Card, ListSkeleton, Text } from '@/shared/ui';

import { RunTimeline } from './RunTimeline';
import type { AutomationDefinition, AutomationRunStep } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        section: { gap: theme.spacing.sm },
        gutter: { paddingHorizontal: theme.spacing.lg },
    });

interface StepsQuery {
    data: { steps: AutomationRunStep[]; definition: AutomationDefinition | null } | undefined;
    isLoading: boolean;
    isError: boolean;
    error: unknown;
    refetch: () => unknown;
}

function StepsBody({ steps }: { steps: StepsQuery }) {
    const styles = useThemedStyles(makeStyles);
    if (steps.isLoading) return <ListSkeleton rows={4} />;
    if (steps.isError) {
        return (
            <View style={styles.gutter}>
                <Banner
                    tone="error"
                    action={<Button label="Retry" variant="ghost" onPress={() => void steps.refetch()} />}
                >
                    {describeError(steps.error).message}
                </Banner>
            </View>
        );
    }
    return (
        <Card padded={false}>
            <RunTimeline steps={steps.data?.steps ?? []} definition={steps.data?.definition ?? null} />
        </Card>
    );
}

export function RunStepsSection({ steps }: { steps: StepsQuery }) {
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.section}>
            <Text variant="label" tone="tertiary" style={styles.gutter}>
                STEP BY STEP
            </Text>
            <StepsBody steps={steps} />
        </View>
    );
}
