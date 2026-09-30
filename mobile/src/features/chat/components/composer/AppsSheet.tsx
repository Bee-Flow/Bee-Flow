/**
 * Which apps this chat may reach (the web's AppsPicker in the composer): the
 * tools the organisation allows, each with its switch. It is the same
 * per-person allow-list as Settings → Integrations (`enabledApps`), and it
 * decides whether the model is offered a tool at all — switching one on does
 * not connect anything.
 */

import React, { useMemo } from 'react';

import { useTranslation } from '@/core/i18n';
import { allowedByOrg, INTEGRATION_CATALOG, useSaveEnabledApps, useUserSettings } from '@/features/integrations';
import { Sheet, ToggleRow } from '@/shared/ui';

export function AppsSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
    const t = useTranslation();
    const settings = useUserSettings();
    const save = useSaveEnabledApps();
    const orgAllowed = settings.data?.orgEnabledIntegrations;
    const catalogue = useMemo(() => allowedByOrg(INTEGRATION_CATALOG, orgAllowed), [orgAllowed]);
    // `null` is "no explicit list": everything allowed is on. The first
    // change writes the whole list, so the switches stay truthful.
    const enabled = settings.data?.enabledApps ?? catalogue.map((entry) => entry.id);

    return (
        <Sheet
            visible={visible}
            onClose={onClose}
            title={t('chat.composer.tools_apps', 'Apps')}
            subtitle={t('chat.composer.tools_apps_hint', 'What this chat may reach — Drive, Gmail, and the rest')}
            tall
        >
            {catalogue.map((entry) => (
                <ToggleRow
                    key={entry.id}
                    label={entry.label}
                    description={entry.description}
                    value={enabled.includes(entry.id)}
                    onValueChange={(on) => save.mutate(on ? [...enabled, entry.id] : enabled.filter((id) => id !== entry.id))}
                    gutter={false}
                />
            ))}
        </Sheet>
    );
}
