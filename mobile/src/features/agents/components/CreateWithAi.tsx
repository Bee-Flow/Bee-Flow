/**
 * "Create with AI" — the web's AgentWizard landing: describe the agent in a
 * sentence (or pick an example), and the builder takes it from there. As on
 * the web, an empty agent is created first and the sentence becomes the
 * first refine on its "Edit with AI" screen, so the whole conversation lives
 * in one place.
 */

import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { BrandMark, Button, ListRow, Text, TextField } from '@/shared/ui';

import { useCreateAgent } from '../hooks/editor';
import { emptyDraft } from '../model/draft';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        content: { padding: theme.spacing.lg, gap: theme.spacing.lg, alignItems: 'stretch' },
        head: { alignItems: 'center', gap: theme.spacing.md },
        examples: { gap: theme.spacing.xs },
    });

export function CreateWithAi() {
    const t = useTranslation();
    const router = useRouter();
    const styles = useThemedStyles(makeStyles);
    const create = useCreateAgent();
    const [prompt, setPrompt] = useState('');
    const examples = [
        { title: t('agent_wizard.example_qna_title', 'Teamchat Q&A'), sub: t('agent_wizard.example_qna_sub', 'Answer questions in team chat using your documentation') },
        { title: t('agent_wizard.example_planner_title', 'Morning Planner'), sub: t('agent_wizard.example_planner_sub', 'Plan my day from my calendar, tasks and open threads') },
        { title: t('agent_wizard.example_bug_title', 'Bug Triage'), sub: t('agent_wizard.example_bug_sub', 'Score incoming bugs, set priorities and log them in the team tracker') },
    ];

    const start = (text: string) => {
        const ask = text.trim();
        if (!ask || create.isPending) return;
        create.mutate(emptyDraft(t('agent_studio.untitled', 'Untitled agent')), {
            onSuccess: (agent) => router.replace(`/agents/${agent.id}/refine?q=${encodeURIComponent(ask)}`),
        });
    };

    return (
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <View style={styles.head}>
                <BrandMark size={56} />
                <Text variant="title" center>
                    {t('agent_wizard.title', 'Create a new agent')}
                </Text>
            </View>
            <TextField
                value={prompt}
                onChangeText={setPrompt}
                placeholder={t('agent_wizard.placeholder_initial', 'Build an agent that answers questions in Slack and other chats based on the documentation I provide.')}
                multiline
                numberOfLines={3}
                editable={!create.isPending}
                error={create.error ? describeError(create.error).message : null}
            />
            <Button label={t('agent_wizard.build', 'Start building')} iconName="Sparkles" loading={create.isPending} disabled={!prompt.trim()} onPress={() => start(prompt)} fullWidth />
            <View style={styles.examples}>
                <Text variant="caption" tone="secondary" weight="medium">
                    {t('agent_wizard.or_template', 'Or start from a template')}
                </Text>
                {examples.map((ex) => (
                    <ListRow key={ex.title} title={ex.title} subtitle={ex.sub} chevron onPress={() => start(`${ex.title}: ${ex.sub}`)} />
                ))}
            </View>
        </ScrollView>
    );
}
