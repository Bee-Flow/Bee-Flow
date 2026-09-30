/**
 * A titled card of runs across routines — "Needs you" and "Recent activity".
 * Both are capped by the hub (four and six rows), so the card maps its rows.
 */

import { useRouter } from 'expo-router';
import React from 'react';
import { View } from 'react-native';

import { useTheme } from '@/core/theme/ThemeProvider';
import { RunRow, type AutomationRun } from '@/features/automations';
import { Card, Divider, Section } from '@/shared/ui';

export function RunCardSection({
    title,
    subtitle,
    runs,
    titleFor,
}: {
    title: string;
    subtitle?: string;
    runs: AutomationRun[];
    titleFor: (automationId: string) => string;
}) {
    const theme = useTheme();
    const router = useRouter();
    return (
        <Section title={title} subtitle={subtitle}>
            <Card padded={false}>
                {runs.map((run, index) => (
                    <View key={run.id}>
                        {index > 0 ? <Divider inset={theme.spacing.lg} /> : null}
                        <RunRow
                            run={run}
                            automationTitle={titleFor(run.automationId)}
                            onPress={() => router.push(`/automations/${run.automationId}/runs?runId=${run.id}`)}
                        />
                    </View>
                ))}
            </Card>
        </Section>
    );
}
