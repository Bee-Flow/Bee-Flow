/**
 * How this person's editor behaves — the web Settings tab's "Editor" row:
 * a preference of the device, not of the automation, so it applies to every
 * automation built on this phone.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { useAutoMapOnConnect } from '@/features/flow-editor/state';
import { Group, ToggleRow } from '@/shared/ui';

export function EditorGroup() {
    const t = useTranslation();
    const [autoMap, setAutoMap] = useAutoMapOnConnect();
    return (
        <Group
            title={t('mobile.flow.settings.editor', 'Editor')}
            footer={t('mobile.flow.settings.editor_hint', 'A preference of this device — it applies to every automation you edit here.')}
        >
            <ToggleRow
                label={t('mobile.flow.settings.auto_map', 'Auto-map step inputs when connecting')}
                description={t('mobile.flow.settings.auto_map_hint', "When you connect two steps, automatically map the new step's inputs from the upstream step's output.")}
                value={autoMap}
                onValueChange={setAutoMap}
                testID="flow-auto-map"
            />
        </Group>
    );
}
