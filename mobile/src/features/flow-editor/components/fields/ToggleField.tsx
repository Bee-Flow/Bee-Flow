/**
 * An on/off setting with its consequence spelled out under it — the web's
 * checkbox rows ("Keep a copy", "Stop the run"), at a thumb's size.
 */

import React from 'react';

import { ToggleRow } from '@/shared/ui';

export function ToggleField({
    value,
    onChange,
    label,
    description,
    disabled,
    testID,
}: {
    value: boolean;
    onChange: (next: boolean) => void;
    label: string;
    description?: string | null;
    disabled?: boolean;
    testID?: string;
}) {
    return (
        <ToggleRow
            label={label}
            description={description ?? undefined}
            value={value}
            onValueChange={onChange}
            disabled={disabled}
            gutter={false}
            testID={testID}
        />
    );
}
