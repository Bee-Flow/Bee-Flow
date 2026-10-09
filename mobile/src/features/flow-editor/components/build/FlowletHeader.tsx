/**
 * A flowlet's screen header — the web header's breadcrumb while scoped: the
 * flowlet's name (tap to rename), a FLOWLET chip, and the way back to the
 * automation that holds it. Runs, going live and Ask AI stay the automation's.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { Badge, ObjectHeader } from '@/shared/ui';

export function FlowletHeader({ title, automation, onRename }: { title: string; automation: string; onRename: () => void }) {
    const t = useTranslation();
    return (
        <ObjectHeader
            kind="automation"
            icon="Layers"
            title={title}
            status={<Badge label={t('automations.node.call_layer.typeLabel', 'Flowlet')} tone="neutral" />}
            onTitlePress={onRename}
            titleHint={t('automations.flowlets_panel.rename_flowlet', 'Rename flowlet')}
            backLabel={t('mobile.flow.flowlets.back_to', 'Back to {name}', { name: automation })}
        />
    );
}
