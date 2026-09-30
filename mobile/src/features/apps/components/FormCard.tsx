/** A Studio form: its fields, and the button that submits them to the action. */

import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Card, Text } from '@/shared/ui';

import { ActionRunner } from './ActionRunner';
import { InputField } from './InputField';
import type { AppBlock } from '../model/appDefinition';
import { initialValues, invalidNumbers, missingRequired, type AppInput } from '../model/inputs';
import type { AppFormValues } from '../model/types';

const makeStyles = (theme: Theme) => StyleSheet.create({ body: { gap: theme.spacing.lg } });

/** Why the button will not send yet: an empty required field, or a number field holding text. */
function blockedReasonOf(t: TranslateFn, inputs: AppInput[], values: AppFormValues): string | null {
    const missing = missingRequired(inputs, values);
    if (missing.length) return t('mobile.apps.still_needed', 'Still needed: {fields}', { fields: missing.join(', ') });
    const notNumbers = invalidNumbers(inputs, values);
    if (notNumbers.length) return t('mobile.apps.not_a_number', 'Not a number: {fields}', { fields: notNumbers.join(', ') });
    return null;
}

export function FormCard({
    appId,
    draft = false,
    block,
}: {
    appId: string;
    /** The app on screen is the owner's draft (ActionRunner). */
    draft?: boolean;
    block: Extract<AppBlock, { kind: 'form' }>;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [values, setValues] = useState<AppFormValues>(() => initialValues(block.inputs));
    const [touched, setTouched] = useState(false);

    const blockedReason = blockedReasonOf(t, block.inputs, values);

    return (
        <Card>
            <View style={styles.body}>
                {block.title ? <Text variant="heading">{block.title}</Text> : null}

                {block.inputs.length === 0 ? (
                    <Text variant="caption" tone="tertiary">
                        {t('mobile.apps.form_no_fields', 'This form has no fields the phone can fill in.')}
                    </Text>
                ) : (
                    block.inputs.map((input) => (
                        <InputField
                            key={input.node.id}
                            input={input}
                            value={values[input.name] ?? null}
                            showError={touched}
                            onChange={(next) => setValues((prev) => ({ ...prev, [input.name]: next }))}
                        />
                    ))
                )}

                {block.action ? (
                    <ActionRunner
                        appId={appId}
                        draft={draft}
                        action={block.action}
                        label={block.submitLabel}
                        blockedReason={blockedReason}
                        onBlocked={() => setTouched(true)}
                        collect={() => values}
                    />
                ) : (
                    <Text variant="caption" tone="tertiary">
                        {t('mobile.apps.form_no_action', 'This form saves as you type on the desktop, and has no submit action of its own.')}
                    </Text>
                )}
            </View>
        </Card>
    );
}
