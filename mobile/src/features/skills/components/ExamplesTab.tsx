/**
 * "Examples" — what a good answer looks like (the web's ExamplesTab). Two or
 * three good ones are enough; a bad one helps with what the agent keeps
 * getting wrong. One BlockList cell per example.
 */

import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { BlockList, type Block } from '@/shared/patterns';
import { Button, Text } from '@/shared/ui';

import { ExampleCard } from './ExampleCard';
import { ExamplePickerSheet } from './ExamplePickerSheet';
import type { SkillEditor } from '../hooks/useSkillEditor';
import { newLocalId } from '../model/skillModel';
import type { SkillExample } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({ actions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm } });

const blank = (): SkillExample => ({
    id: newLocalId('ex'),
    question: '',
    good: '',
    rationale: '',
    bad: '',
    violatedRuleId: '',
    sourceConversationId: '',
});

function Intro({ readOnly, onAdd, onPick }: { readOnly: boolean; onAdd: () => void; onPick: () => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <>
            <Text variant="caption" tone="secondary">
                {t(
                    'skills_studio.examples.intro',
                    'Examples show what it should look like. Two or three good ones are enough; a bad one helps with things the agent keeps getting wrong.',
                )}
            </Text>
            {readOnly ? null : (
                <View style={styles.actions}>
                    <Button size="sm" iconName="Plus" label={t('skills_studio.examples.add', 'Example')} onPress={onAdd} testID="skill-example-add" />
                    <Button size="sm" variant="secondary" iconName="MessageSquare" label={t('skills_studio.examples.from_chat', 'Pick from a conversation')} onPress={onPick} />
                </View>
            )}
        </>
    );
}

export function ExamplesTab({
    skillId,
    editor,
    refreshing,
    onRefresh,
}: {
    skillId: string;
    editor: SkillEditor;
    refreshing: boolean;
    onRefresh: () => void;
}) {
    const t = useTranslation();
    const [picking, setPicking] = useState(false);
    const { draft, patch, locked } = editor;
    const rows = draft.examplesV2;
    const set = (next: SkillExample[]) => patch({ examplesV2: next });
    const blocks: Block[] = [
        { key: 'intro', gap: 'section', render: () => <Intro readOnly={locked} onAdd={() => set([...rows, blank()])} onPick={() => setPicking(true)} /> },
        ...rows.map((example): Block => ({
            key: `ex:${example.id}`,
            gap: 'section',
            render: () => (
                <ExampleCard
                    example={example}
                    rules={draft.rulesV2}
                    readOnly={locked}
                    onPatch={(next) => set(rows.map((e) => (e.id === example.id ? { ...e, ...next } : e)))}
                    onRemove={() => set(rows.filter((e) => e.id !== example.id))}
                />
            ),
        })),
    ];
    if (rows.length === 0) {
        blocks.push({ key: 'empty', gap: 'inner', render: () => <Text variant="caption" tone="tertiary">{t('skills_studio.examples.empty', 'No examples yet.')}</Text> });
    }
    return (
        <>
            <BlockList blocks={blocks} refreshing={refreshing} onRefresh={onRefresh} testID="skill-examples" />
            <ExamplePickerSheet
                visible={picking}
                skillId={skillId}
                onClose={() => setPicking(false)}
                onTaken={(example) => {
                    setPicking(false);
                    set([...rows, example]);
                }}
            />
        </>
    );
}
