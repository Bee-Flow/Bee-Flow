/**
 * One of several, in a sheet — the phone's form of the web filter bar's
 * <select>s (trigger, live or test, which automation). The chosen row carries the
 * check; picking one closes the sheet.
 */

import React from 'react';

import { OptionRow, Sheet } from '@/shared/ui';

export interface Choice {
    /** '' stands for "any". */
    value: string;
    label: string;
}

export function ChoiceSheet({
    visible,
    title,
    choices,
    value,
    onPick,
    onClose,
}: {
    visible: boolean;
    title: string;
    choices: readonly Choice[];
    value: string;
    onPick: (value: string) => void;
    onClose: () => void;
}) {
    return (
        <Sheet visible={visible} onClose={onClose} title={title}>
            {choices.map((choice) => (
                <OptionRow
                    key={choice.value || 'any'}
                    label={choice.label}
                    selected={choice.value === value}
                    onPress={() => {
                        onPick(choice.value);
                        onClose();
                    }}
                    testID={`choice-${choice.value || 'any'}`}
                />
            ))}
        </Sheet>
    );
}
