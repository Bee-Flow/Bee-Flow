/**
 * The empty-skill head start — the web's FillInCard. Offered only while the
 * skill has no method: one sentence is all an empty skill can give a model,
 * and once there is something on the page "Improve with AI" is the action
 * that has the current skill to work from.
 */

import React, { useState } from 'react';
import { StyleSheet } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Card, Text, TextField } from '@/shared/ui';

const makeStyles = (theme: Theme) => StyleSheet.create({ card: { gap: theme.spacing.md } });

export function FillInCard({ drafting, onFillIn }: { drafting: boolean; onFillIn: (sentence: string) => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [sentence, setSentence] = useState('');
    return (
        <Card style={styles.card} testID="skill-fill-in">
            <Text variant="subheading">{t('skills_studio.fill.title', 'Start from one sentence')}</Text>
            <TextField
                accessibilityLabel={t('skills_studio.fill.label', 'What should this skill do?')}
                value={sentence}
                onChangeText={setSentence}
                placeholder={t('skills_studio.fill.placeholder', 'Describe in one sentence what this skill should do…')}
                multiline
                maxLines={3}
            />
            <Button
                iconName="Sparkles"
                label={drafting ? t('skills_studio.fill.working', 'Writing…') : t('skills_studio.fill.button', 'Let AI fill it in')}
                loading={drafting}
                disabled={!sentence.trim()}
                onPress={() => onFillIn(sentence.trim())}
                testID="skill-fill-in-run"
            />
        </Card>
    );
}
