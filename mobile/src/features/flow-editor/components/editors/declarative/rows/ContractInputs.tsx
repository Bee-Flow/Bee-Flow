/**
 * A call's inputs — one binding per input the flowlet or Step declares, the
 * web's CallContractFields rows. The row is named by the contract's label, or
 * its key read as words (`klant_naam` → "Klant naam"): a machine key read out
 * loud made a flowlet's inputs look like a JSON schema instead of a form. An
 * emptied input is left out of the call.
 */

import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { BindingValue } from '@/features/flow-editor/bindings';
import { BindingInput } from '@/features/flow-editor/components/fields';
import { humanizeFieldKey } from '@/features/flow-editor/model';
import { updateInput, type Inputs } from '@/features/flow-editor/schemaForm';

import type { ContractParam } from '../spec';

export function ContractInputs({
    contract,
    value,
    onChange,
    disabled,
}: {
    contract: readonly ContractParam[];
    value: unknown;
    onChange: (next: Inputs) => void;
    disabled?: boolean;
}) {
    const styles = useThemedStyles(makeStyles);
    const inputs = (value && typeof value === 'object' ? value : {}) as Inputs;
    return (
        <View style={styles.list}>
            {contract.map((p) => (
                <BindingInput
                    key={p.name}
                    label={p.label || humanizeFieldKey(p.name) || p.name}
                    hint={p.description || null}
                    required={!!p.required}
                    value={inputs[p.name] ?? null}
                    onChange={(b) => onChange(updateInput(inputs, p.name, b as BindingValue))}
                    disabled={disabled}
                    testID={`contract-${p.name}`}
                />
            ))}
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    list: { gap: theme.spacing.lg } satisfies ViewStyle,
});
