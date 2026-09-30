/**
 * One worked example — the web's ExamplesTab card: the question, the good
 * answer and why it is good, and optionally an answer to avoid with the rule
 * it breaks. A rule the example named that has since been deleted says so
 * instead of silently reading "No specific rule".
 */

import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { ActionMenu, Button, Card, Icon, IconButton, ListRow, Text, TextField, type ActionMenuItem } from '@/shared/ui';

import type { SkillExample, SkillRule } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        card: { gap: theme.spacing.md },
        foot: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
        grow: { flex: 1 },
    });

function ruleLabel(t: TranslateFn, example: SkillExample, rules: readonly SkillRule[]): string {
    if (!example.violatedRuleId) return t('skills_studio.examples.no_rule', 'No specific rule');
    const rule = rules.find((r) => r.id === example.violatedRuleId);
    return rule ? rule.text || rule.id : t('skills_studio.examples.rule_gone', 'The rule this broke was removed');
}

function ruleItems(t: TranslateFn, example: SkillExample, rules: readonly SkillRule[], onPick: (id: string) => void): ActionMenuItem[] {
    return [
        { id: 'none', label: t('skills_studio.examples.no_rule', 'No specific rule'), selected: !example.violatedRuleId, onPress: () => onPick('') },
        ...rules.map((r) => ({ id: r.id, label: r.text || r.id, selected: r.id === example.violatedRuleId, onPress: () => onPick(r.id) })),
    ];
}

function AvoidFields({ example, rules, readOnly, onPatch }: { example: SkillExample; rules: readonly SkillRule[]; readOnly: boolean; onPatch: (n: Partial<SkillExample>) => void }) {
    const t = useTranslation();
    const [picking, setPicking] = useState(false);
    return (
        <>
            <TextField label={t('skills_studio.examples.bad', 'Not like this')} value={example.bad} editable={!readOnly} multiline maxLines={6}
                onChangeText={(bad) => onPatch({ bad })} />
            <ListRow title={t('skills_studio.examples.violates', 'Rule it breaks')} subtitle={ruleLabel(t, example, rules)}
                chevron={!readOnly} onPress={readOnly ? undefined : () => setPicking(true)} />
            <ActionMenu visible={picking} onClose={() => setPicking(false)} title={t('skills_studio.examples.violates', 'Rule it breaks')}
                items={ruleItems(t, example, rules, (violatedRuleId) => onPatch({ violatedRuleId }))} />
        </>
    );
}

export function ExampleCard({
    example,
    rules,
    readOnly,
    onPatch,
    onRemove,
}: {
    example: SkillExample;
    rules: readonly SkillRule[];
    readOnly: boolean;
    onPatch: (next: Partial<SkillExample>) => void;
    onRemove: () => void;
}) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const [revealed, setRevealed] = useState(false);
    const showBad = revealed || Boolean(example.bad) || Boolean(example.violatedRuleId);
    return (
        <Card style={styles.card} testID="skill-example">
            <TextField label={t('skills_studio.examples.question', 'When someone asks')} value={example.question} editable={!readOnly}
                multiline maxLines={6} onChangeText={(question) => onPatch({ question })} />
            <TextField label={t('skills_studio.examples.good', 'Good answer')} value={example.good} editable={!readOnly}
                multiline maxLines={8} onChangeText={(good) => onPatch({ good })} />
            <TextField label={t('skills_studio.examples.rationale', 'Why this is good')} value={example.rationale} editable={!readOnly}
                onChangeText={(rationale) => onPatch({ rationale })} />
            {showBad ? <AvoidFields example={example} rules={rules} readOnly={readOnly} onPatch={onPatch} /> : null}
            {!showBad && !readOnly ? (
                <Button variant="ghost" size="sm" label={t('skills_studio.examples.add_bad', 'Add an answer to avoid')} onPress={() => setRevealed(true)} />
            ) : null}
            <View style={styles.foot}>
                <View style={styles.grow}>
                    {example.sourceConversationId ? (
                        <Text variant="caption" tone="tertiary">
                            {t('skills_studio.examples.source_note', 'Taken from a conversation')}
                        </Text>
                    ) : null}
                </View>
                {readOnly ? null : (
                    <IconButton icon={<Icon name="Trash2" size={18} color={theme.colors.textTertiary} />}
                        accessibilityLabel={t('skills_studio.examples.remove', 'Remove example')} onPress={onRemove} />
                )}
            </View>
        </Card>
    );
}
