/**
 * What every step has, above its own editor: its name and optional symbol
 * (the web's SettingsForm Label row — "a name and an optional symbol for this
 * step, shown on its node"), and, for a step that runs, the node editor's
 * Disable switch (NodeDetailView: skipped during execution). A trigger has no
 * switch: the runner never checks one there, so it would be a lie.
 */

import React, { useState, type RefObject } from 'react';
import { Pressable, View, type TextInput, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { FlowNode } from '@/features/flow-editor/bindings';
import { defaultLabelPlaceholder } from '@/features/flow-editor/formState';
import type { AnyNode } from '@/features/flow-editor/model';
import { isDisabled } from '@/features/flow-editor/model/outline';
import { Icon, TextField } from '@/shared/ui';

import { SymbolSheet } from './SymbolSheet';
import type { StepFormState } from './useStepForm';
import { ToggleField } from '../fields';
import { stepIconName } from '../outline/stepIcons';

export function StepBasics({ form, step, locked, nameRef }: { form: StepFormState; step: FlowNode; locked: boolean; nameRef: RefObject<TextInput | null> }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [picking, setPicking] = useState(false);
    const icon = typeof form.draft.icon === 'string' ? form.draft.icon : '';
    const runs = step.type !== 'trigger' && step.type !== 'note';
    return (
        <>
            <View style={styles.row}>
                <Pressable
                    style={styles.symbol}
                    onPress={() => setPicking(true)}
                    disabled={locked}
                    accessibilityRole="button"
                    accessibilityLabel={t('mobile.flow.ndv.symbol_title', 'Choose a symbol for this step')}
                    testID="step-symbol"
                >
                    <Icon name={stepIconName({ ...step, icon: icon || null } as AnyNode)} size={20} color={icon ? styles.set.color : styles.unset.color} />
                </Pressable>
                <View style={styles.name}>
                    <TextField
                        ref={nameRef}
                        label={t('common.name', 'Name')}
                        value={typeof form.draft.label === 'string' ? form.draft.label : ''}
                        onChangeText={(label) => form.set('label', label)}
                        placeholder={defaultLabelPlaceholder(step)}
                        editable={!locked}
                        testID="step-name"
                    />
                </View>
            </View>
            {runs ? (
                <ToggleField
                    label={t('routines.ndv.disabled', 'Disabled')}
                    description={t('routines.ndv.disable_title', 'Disable this node (skipped during execution)')}
                    value={isDisabled(step)}
                    onChange={(off) => form.patchStep({ disabled: off })}
                    disabled={locked}
                    testID="step-disabled"
                />
            ) : null}
            <SymbolSheet
                visible={picking}
                value={icon}
                onClose={() => setPicking(false)}
                onPick={(name) => {
                    setPicking(false);
                    form.set('icon', name);
                }}
            />
        </>
    );
}

const makeStyles = (theme: Theme) => ({
    row: { flexDirection: 'row', alignItems: 'flex-end', gap: theme.spacing.sm } satisfies ViewStyle,
    name: { flex: 1 } satisfies ViewStyle,
    symbol: {
        width: 48, height: 48, borderRadius: theme.radii.md, alignItems: 'center', justifyContent: 'center',
        borderWidth: 1, borderColor: theme.colors.borderDefault, backgroundColor: theme.colors.bgSecondary,
    } satisfies ViewStyle,
    set: { color: theme.colors.textPrimary },
    unset: { color: theme.colors.textTertiary },
});
