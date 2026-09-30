/**
 * One rule — the web's RulesEditor row. Polarity is a CONTROL, not a word in
 * the sentence: the check/ban mark is a button that flips the rule between
 * "always" and "never", so the mark and the prompt say the same thing.
 * Colours come from the status pairs (success / error ink), never a hex.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Card, Icon, IconButton, TextField } from '@/shared/ui';

import type { SkillRule } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        row: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs },
        grow: { flex: 1 },
    });

export function RuleRow({
    rule,
    readOnly,
    onChange,
    onRemove,
}: {
    rule: SkillRule;
    readOnly: boolean;
    onChange: (rule: SkillRule) => void;
    onRemove: () => void;
}) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const never = rule.polarity === 'never';
    const state = never ? t('skills_studio.rules.never', 'Never') : t('skills_studio.rules.must', 'Always');
    const flip = never
        ? t('skills_studio.rules.set_must', 'Change to “always do this”')
        : t('skills_studio.rules.set_never', 'Change to “never do this”');
    return (
        <Card padded={false} testID="skill-rule">
            <View style={styles.row}>
                <IconButton
                    icon={<Icon name={never ? 'Ban' : 'Check'} size={18} color={never ? theme.colors.errorInk : theme.colors.successInk} />}
                    accessibilityLabel={readOnly ? state : flip}
                    disabled={readOnly}
                    onPress={() => onChange({ ...rule, polarity: never ? 'must' : 'never' })}
                    testID="skill-rule-polarity"
                />
                <View style={styles.grow}>
                    <TextField
                        accessibilityLabel={t('skills_studio.rules.text', 'Rule')}
                        value={rule.text}
                        onChangeText={(text) => onChange({ ...rule, text })}
                        placeholder={t('skills_studio.rules.placeholder', 'One sentence — what always holds?')}
                        editable={!readOnly}
                        multiline
                        maxLines={4}
                    />
                </View>
                {readOnly ? null : (
                    <IconButton
                        icon={<Icon name="Trash2" size={18} color={theme.colors.textTertiary} />}
                        accessibilityLabel={t('skills_studio.rules.remove', 'Remove rule')}
                        onPress={onRemove}
                    />
                )}
            </View>
        </Card>
    );
}
