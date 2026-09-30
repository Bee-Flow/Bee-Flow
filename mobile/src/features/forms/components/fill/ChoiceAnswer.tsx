/**
 * A dropdown question. A handful of choices are laid out as rows to tap; a
 * long list (a form allows fifty) opens in a sheet instead, so the page does
 * not become one question long. Tapping the chosen row of an optional
 * question clears it — the only way to take an answer back.
 */

import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import type { FillField } from '@/features/forms/model/fillTypes';
import { Button, Card, OptionRow, Sheet } from '@/shared/ui';

import { AnswerRow } from './AnswerRow';
import { labelOf, type AnswerProps } from './types';

/** Up to this many, the choices sit on the page. */
export const INLINE_CHOICES = 6;

function Choices({ field, chosen, onPick, disabled }: { field: FillField; chosen: string; onPick: (v: string) => void; disabled: boolean }) {
    return (
        <Card padded={false}>
            {field.options.map((o) => (
                <OptionRow
                    key={o.value}
                    label={o.label}
                    selected={o.value === chosen}
                    onPress={() => onPick(o.value === chosen && !field.required ? '' : o.value)}
                    disabled={disabled}
                    testID={`fill-${field.name}-${o.value}`}
                />
            ))}
        </Card>
    );
}

export function ChoiceAnswer({ field, value, error, disabled, onChange }: AnswerProps) {
    const t = useTranslation();
    const [open, setOpen] = useState(false);
    const chosen = typeof value === 'string' ? value : '';
    const chosenLabel = field.options.find((o) => o.value === chosen)?.label ?? '';
    const inline = field.options.length <= INLINE_CHOICES;
    return (
        <AnswerRow label={labelOf(field)} help={field.help} error={error}>
            {inline ? (
                <Choices field={field} chosen={chosen} onPick={onChange} disabled={disabled} />
            ) : (
                <Button
                    variant="secondary"
                    iconName="ChevronDown"
                    label={chosenLabel || field.placeholder || t('mobile.forms.fill.choose', 'Choose…')}
                    onPress={() => setOpen(true)}
                    disabled={disabled}
                    testID={`fill-${field.name}`}
                />
            )}
            <Sheet visible={open} onClose={() => setOpen(false)} title={field.label || field.name} tall>
                <Choices
                    field={field}
                    chosen={chosen}
                    onPick={(next) => {
                        onChange(next);
                        setOpen(false);
                    }}
                    disabled={disabled}
                />
            </Sheet>
        </AnswerRow>
    );
}
