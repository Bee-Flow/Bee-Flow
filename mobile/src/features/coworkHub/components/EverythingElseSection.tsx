/** Where everything lives: the four Automate destinations, as rows. */

import { useRouter } from 'expo-router';
import React from 'react';

import { useTheme } from '@/core/theme/ThemeProvider';
import { openRoute } from '@/shared/navigation';
import { Card, Divider, Icon, Section, SettingRow, type IconName } from '@/shared/ui';

export function EverythingElseSection({
    automationCount,
    taskCount,
}: {
    /** Undefined until the list has loaded, so no count is guessed. */
    automationCount: number | undefined;
    taskCount: number | undefined;
}) {
    const theme = useTheme();
    const router = useRouter();
    const icon = (name: IconName) => (
        <Icon name={name} size={18} color={theme.colors.textMuted} />
    );
    return (
        <Section title="Everything else">
            <Card padded={false}>
                <SettingRow
                    label="Automations"
                    value={automationCount === undefined ? undefined : String(automationCount)}
                    icon={icon('Zap')}
                    onPress={() => router.push('/automations')}
                />
                <Divider inset={theme.spacing.lg} />
                <SettingRow
                    label="Tasks and reminders"
                    value={taskCount === undefined ? undefined : String(taskCount)}
                    icon={icon('SquareCheckBig')}
                    onPress={() => router.push('/tasks')}
                />
                <Divider inset={theme.spacing.lg} />
                <SettingRow label="Projects" icon={icon('Folder')} onPress={() => router.push('/projects')} />
                <Divider inset={theme.spacing.lg} />
                <SettingRow label="Apps" icon={icon('PanelsTopLeft')} onPress={() => openRoute(router, '/apps')} />
            </Card>
        </Section>
    );
}
