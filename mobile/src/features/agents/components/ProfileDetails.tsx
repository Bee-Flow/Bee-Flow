/** Model, guardrails and last change. (Editing is ProfileEditActions, above it.) */

import React from 'react';

import { timeAgo, useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Card, Divider, Icon, ListRow, Section, type IconName } from '@/shared/ui';

import { describeModel } from '../model/format';
import type { Agent } from '../model/types';

export function ProfileDetails({ agent }: { agent: Agent }) {
    useTranslation(); // re-render when the language changes: timeAgo speaks it
    const theme = useTheme();
    const icon = (name: IconName) => (
        <Icon name={name} size={18} color={theme.colors.textMuted} />
    );
    return (
        <Section title="Details">
            <Card padded={false}>
                <ListRow title="Model" subtitle={describeModel(agent.model)} leading={icon('Cpu')} />
                <Divider inset={theme.spacing.lg} />
                <ListRow
                    title="Guardrails"
                    subtitle={
                        agent.config.enableGuardrails
                            ? 'Responses are screened before you see them.'
                            : 'Not enabled for this agent.'
                    }
                    leading={icon('Shield')}
                />
                {agent.updated_at ? (
                    <>
                        <Divider inset={theme.spacing.lg} />
                        <ListRow title="Last changed" subtitle={timeAgo(agent.updated_at)} leading={icon('Clock')} />
                    </>
                ) : null}
            </Card>
        </Section>
    );
}
