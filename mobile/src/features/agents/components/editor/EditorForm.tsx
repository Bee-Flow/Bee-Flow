/**
 * Every field of the manual editor, top to bottom in the order a person
 * builds an agent: who it is, how it behaves, what it starts with, what it
 * knows — and, folded away, the apps and behaviour switches (the web's
 * "Advanced settings"). The screen adds sharing and the save bar.
 */

import React, { useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { AgentForm } from '@/features/agents/hooks/useAgentForm';
import { Button, Section } from '@/shared/ui';

import { AppsField } from './AppsField';
import { BehaviourFields } from './BehaviourFields';
import { IdentityFields } from './IdentityFields';
import { InstructionsField } from './InstructionsField';
import { KnowledgeField } from './KnowledgeField';
import { ModelField } from './ModelField';
import { StartersField } from './StartersField';

const makeStyles = (theme: Theme) => StyleSheet.create({ stack: { gap: theme.spacing.xl }, advanced: { gap: theme.spacing.md } });

export interface EditorFormProps {
    form: AgentForm;
    disabled: boolean;
    /** Rows only an existing agent has (sharing), drawn in the advanced group. */
    extra?: ReactNode;
}

export function EditorForm({ form, disabled, extra }: EditorFormProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [advanced, setAdvanced] = useState(false);
    const label = t('agent_wizard.builder.advanced_settings', 'Advanced settings');

    return (
        <View style={styles.stack}>
            <IdentityFields form={form} disabled={disabled} />
            <ModelField form={form} disabled={disabled} />
            <InstructionsField form={form} disabled={disabled} />
            <StartersField form={form} disabled={disabled} />
            <KnowledgeField form={form} disabled={disabled} />
            <Button
                label={label}
                variant="ghost"
                iconName={advanced ? 'ChevronDown' : 'ChevronRight'}
                onPress={() => setAdvanced((v) => !v)}
                accessibilityHint={label}
            />
            {advanced ? (
                <Section>
                    <View style={styles.advanced}>
                        <AppsField form={form} disabled={disabled} />
                        <BehaviourFields form={form} disabled={disabled} />
                        {extra}
                    </View>
                </Section>
            ) : null}
        </View>
    );
}
