/** Rename a notebook or one of its sources: one field, prefilled. */

import React, { useState } from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { Button, Sheet, Text, TextField } from '@/shared/ui';

export interface RenameSheetProps {
    /** The current name, or null while closed. */
    name: string | null;
    busy: boolean;
    error: unknown;
    onSubmit: (name: string) => void;
    onClose: () => void;
}

function RenameBody({ name, busy, error, onSubmit }: Omit<RenameSheetProps, 'onClose'> & { name: string }) {
    const t = useTranslation();
    const [draft, setDraft] = useState(name);
    const clean = draft.replace(/\s+/g, ' ').trim();
    const submit = () => {
        if (clean && clean !== name) onSubmit(clean);
    };
    return (
        <>
            <TextField
                label={t('notebooks.rename', 'Rename')}
                value={draft}
                onChangeText={setDraft}
                autoFocus
                selectTextOnFocus
                onSubmitEditing={submit}
                returnKeyType="done"
            />
            {error ? (
                <Text variant="caption" tone="error" accessibilityLiveRegion="polite">
                    {describeError(error).message}
                </Text>
            ) : null}
            <Button
                label={t('notebooks.rename', 'Rename')}
                fullWidth
                loading={busy}
                disabled={!clean || clean === name}
                onPress={submit}
            />
        </>
    );
}

export function RenameSheet(props: RenameSheetProps) {
    const t = useTranslation();
    return (
        <Sheet visible={props.name !== null} onClose={props.onClose} title={t('notebooks.rename', 'Rename')} subtitle={props.name ?? undefined}>
            {/* Keyed by the name so reopening starts from the current one. */}
            {props.name !== null ? <RenameBody key={props.name} {...props} name={props.name} /> : null}
        </Sheet>
    );
}
