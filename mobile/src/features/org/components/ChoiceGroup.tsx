/**
 * The web's ChoiceCards (one column) as a group of options: a label, what it
 * means, and — for a choice the server will not accept — the reason, shown
 * on the disabled row rather than hiding the row. An admin must be able to
 * tell "this product has no such option" from "your plan does not include it".
 */

import React from 'react';

import { Group, OptionRow } from '@/shared/ui';

export interface Choice<T extends string> {
    value: T;
    label: string;
    description?: string;
    disabled?: boolean;
    /** Why a disabled choice is disabled. */
    lockedNote?: string | null;
}

export function ChoiceGroup<T extends string>({
    title,
    footer,
    choices,
    value,
    onChange,
    disabled = false,
}: {
    title?: string;
    footer?: string;
    choices: Choice<T>[];
    value: T | null;
    onChange: (next: T) => void;
    disabled?: boolean;
}) {
    return (
        <Group title={title} footer={footer}>
            {choices.map((choice) => (
                <OptionRow
                    key={choice.value}
                    testID={`choice-${choice.value}`}
                    label={choice.label}
                    description={[choice.description, choice.lockedNote].filter(Boolean).join('\n\n') || undefined}
                    selected={value === choice.value}
                    disabled={disabled || choice.disabled}
                    onPress={() => onChange(choice.value)}
                />
            ))}
        </Group>
    );
}
