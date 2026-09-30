/**
 * Pick one role — for a member or for a group. Each option says what the role
 * is for (roleCopy's description), so the choice is made with the consequence
 * in view instead of from a bare name. Picking closes the sheet; the caller
 * confirms and saves.
 */

import React from 'react';

import { Group, OptionRow, Sheet } from '@/shared/ui';

export interface RoleOption {
    id: string;
    label: string;
    description?: string;
}

export function RolePickerSheet({
    visible,
    onClose,
    title,
    subtitle,
    options,
    current,
    onPick,
    testIDPrefix,
}: {
    visible: boolean;
    onClose: () => void;
    title: string;
    subtitle?: string;
    options: readonly RoleOption[];
    current: string;
    onPick: (id: string) => void;
    /** Each option is `${testIDPrefix}${id}`. */
    testIDPrefix: string;
}) {
    return (
        <Sheet visible={visible} onClose={onClose} title={title} subtitle={subtitle}>
            <Group>
                {options.map((o) => (
                    <OptionRow
                        key={o.id}
                        testID={`${testIDPrefix}${o.id}`}
                        label={o.label}
                        description={o.description || undefined}
                        selected={o.id === current}
                        onPress={() => {
                            onClose();
                            if (o.id !== current) onPick(o.id);
                        }}
                    />
                ))}
            </Group>
        </Sheet>
    );
}
