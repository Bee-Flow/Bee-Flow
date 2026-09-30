/**
 * A bottom sheet holding a form: title, scrollable fields, the submit error as
 * an inline banner, and the submit button (plus an optional cancel) docked at
 * the bottom where a thumb can reach it.
 *
 * The shape every rename/edit sheet in the app wrote by hand. Pair it with
 * useForm, or drive it from a mutation — it only needs the four submit props.
 */

import React, { type ReactNode } from 'react';

import { describeError } from '@/core/api/errors';
import { Banner, Button, Sheet } from '@/shared/ui';

export interface FormSheetProps {
    visible: boolean;
    onClose: () => void;
    title: string;
    subtitle?: string;
    /** The fields. Rendered in the sheet's scroll view. */
    children: ReactNode;
    submitLabel: string;
    onSubmit: () => void;
    /** Shows the button's spinner and blocks a second press. */
    submitting?: boolean;
    /** False disables the submit button (an invalid or untouched form). */
    canSubmit?: boolean;
    /** Whatever the submit threw; shown above the fields via describeError. */
    error?: unknown;
    /** Adds a quiet cancel button under submit. The sheet's × closes regardless. */
    cancelLabel?: string;
    /** `danger` for a form whose submit removes something (the web's tinted danger button). */
    variant?: 'primary' | 'danger';
}

export function FormSheet({
    visible,
    onClose,
    title,
    subtitle,
    children,
    submitLabel,
    onSubmit,
    submitting = false,
    canSubmit = true,
    error,
    cancelLabel,
    variant = 'primary',
}: FormSheetProps) {
    const footer = (
        <>
            <Button
                label={submitLabel}
                onPress={onSubmit}
                disabled={!canSubmit}
                loading={submitting}
                variant={variant}
                fullWidth
                size="lg"
            />
            {cancelLabel ? <Button label={cancelLabel} onPress={onClose} variant="ghost" fullWidth /> : null}
        </>
    );
    return (
        <Sheet visible={visible} onClose={onClose} title={title} subtitle={subtitle} footer={footer}>
            {error ? <Banner tone="error">{describeError(error).message}</Banner> : null}
            {children}
        </Sheet>
    );
}
