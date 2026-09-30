/** Before the first refine: what this is for, and three things to ask (the web's empty rail). */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { BrandMark, Chip, Text } from '@/shared/ui';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: theme.spacing.xl, gap: theme.spacing.md },
        prompts: { alignSelf: 'stretch', gap: theme.spacing.sm },
    });

export function RefineEmpty({ onPick }: { onPick: (text: string) => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const prompts = [
        t('agent_wizard.builder.chat_prompt_tone', 'Make the tone more friendly'),
        t('agent_wizard.builder.chat_prompt_steps', 'Add a step to summarise the result at the end'),
        t('agent_wizard.builder.chat_prompt_constraint', 'Always answer in Dutch unless asked otherwise'),
    ];
    return (
        <View style={styles.wrap}>
            <BrandMark size={48} />
            <Text variant="heading" center>
                {t('agent_wizard.builder.chat_empty_title', 'Refine this agent with AI')}
            </Text>
            <Text variant="body" tone="secondary" center>
                {t('agent_wizard.builder.chat_empty_subtitle', "Tell me what to change — I'll update the instructions, knowledge, or behaviour.")}
            </Text>
            <View style={styles.prompts}>
                {prompts.map((prompt) => (
                    <Chip key={prompt} label={prompt} onPress={() => onPick(prompt)} />
                ))}
            </View>
        </View>
    );
}
