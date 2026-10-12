/**
 * Rename a flowlet — its display title only: calls address a flowlet by its
 * key, which never changes (model/flowlets renameLayer). One undoable edit of
 * the automation's draft. Mounted only while open.
 */

import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { Button, Sheet, TextField } from '@/shared/ui';

export function RenameFlowletSheet({ title, onRename, onClose }: { title: string; onRename: (title: string) => void; onClose: () => void }) {
    const t = useTranslation();
    const [text, setText] = useState(title);
    const next = text.trim();
    return (
        <Sheet
            visible
            onClose={onClose}
            title={t('automations.flowlets_panel.rename_flowlet', 'Rename flowlet')}
            footer={
                <Button
                    label={t('common.save', 'Save')}
                    onPress={() => {
                        onRename(next);
                        onClose();
                    }}
                    disabled={!next || next === title}
                    fullWidth
                    size="lg"
                    testID="flowlet-rename-save"
                />
            }
        >
            <TextField label={t('common.name', 'Name')} value={text} onChangeText={setText} autoCapitalize="sentences" autoFocus testID="flowlet-rename-input" />
        </Sheet>
    );
}
