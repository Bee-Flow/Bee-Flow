/**
 * Rename the routine — the web header's click-to-rename title. The name
 * goes through its own call (useUpdateFlowMeta); the definition stays the
 * draft store's. Mounted only while open, so every opening starts from the
 * current name.
 */

import React, { useState } from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useUpdateFlowMeta } from '@/features/flow-editor/hooks';
import { Banner, Button, Sheet, TextField, useToast } from '@/shared/ui';

export function RenameSheet({ flowKey, title, onClose }: { flowKey: string; title: string; onClose: () => void }) {
    const t = useTranslation();
    const { toast } = useToast();
    const [text, setText] = useState(title);
    const rename = useUpdateFlowMeta(flowKey, {
        onSuccess: () => {
            toast(t('common.saved', 'Saved'), 'success');
            onClose();
        },
    });
    const next = text.trim();
    return (
        <Sheet
            visible
            onClose={onClose}
            title={t('mobile.flow.rename', 'Rename routine')}
            footer={
                <Button
                    label={t('common.save', 'Save')}
                    onPress={() => rename.mutate({ title: next })}
                    disabled={!next || next === title}
                    loading={rename.isPending}
                    fullWidth
                    size="lg"
                />
            }
        >
            {rename.isError ? <Banner tone="error">{describeError(rename.error).message}</Banner> : null}
            <TextField
                label={t('common.name', 'Name')}
                value={text}
                onChangeText={setText}
                autoCapitalize="sentences"
                autoFocus
            />
        </Sheet>
    );
}
