/**
 * The top of the Test tab: who answers ("as agent", or just this skill), the
 * question, and Run. The agent list comes from the SAME endpoint the server
 * authorises `agentId` against; a failed read says so and leaves the choice
 * on "just this skill" rather than showing an empty picker.
 */

import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { ActionMenu, Button, Card, ListRow, Text, TextField, type ActionMenuItem } from '@/shared/ui';

import type { TestAgent } from '../model/types';

export function TestForm({
    agents,
    agentsFailed,
    canRun,
    running,
    onRun,
}: {
    agents: readonly TestAgent[] | undefined;
    agentsFailed: boolean;
    canRun: boolean;
    running: boolean;
    onRun: (input: { agentId: string | null; question: string }) => void;
}) {
    const t = useTranslation();
    const [agentId, setAgentId] = useState<string | null>(null);
    const [question, setQuestion] = useState('');
    const [picking, setPicking] = useState(false);
    const justSkill = t('skills_studio.test.no_agent', 'Just this skill');
    const items: ActionMenuItem[] = [
        { id: '', label: justSkill, selected: agentId === null, onPress: () => setAgentId(null) },
        ...(agents ?? []).map((a) => ({ id: a.id, label: a.name, selected: a.id === agentId, onPress: () => setAgentId(a.id) })),
    ];
    const chosen = agents?.find((a) => a.id === agentId)?.name ?? justSkill;
    return (
        <>
            <Card padded={false}>
                <ListRow
                    title={t('skills_studio.test.as_agent', 'as agent')}
                    subtitle={chosen}
                    chevron={Boolean(agents?.length)}
                    onPress={agents?.length ? () => setPicking(true) : undefined}
                />
            </Card>
            {agentsFailed ? (
                <Text variant="caption" tone="warning">
                    {t('skills_studio.test.agents_failed', 'Could not load your agents, so a test cannot run as one.')}
                </Text>
            ) : null}
            <TextField
                label={t('skills_studio.test.question', 'Question')}
                value={question}
                onChangeText={setQuestion}
                placeholder={t('skills_studio.test.placeholder', 'Ask something this skill should handle…')}
                multiline
                maxLines={4}
            />
            <Button
                iconName="Play"
                label={running ? t('skills_studio.test.running', 'Running…') : t('skills_studio.test.run', 'Run')}
                loading={running}
                disabled={!canRun || !question.trim()}
                onPress={() => onRun({ agentId, question: question.trim() })}
                testID="skill-test-run"
            />
            <ActionMenu visible={picking} onClose={() => setPicking(false)} title={t('skills_studio.test.as_agent', 'as agent')} items={items} />
        </>
    );
}
