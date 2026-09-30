/**
 * The apps this agent may use (`config.enabledIntegrations`) — the web's
 * AppsPicker as a row and a sheet. Only apps the organisation allows are
 * offered; an app switched on here still runs only the actions granted in
 * `config.tools`, which the phone leaves as it is.
 */

import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import type { AgentForm } from '@/features/agents/hooks/useAgentForm';
import { toggleId } from '@/features/agents/model/draft';
import { availableAgentApps } from '@/features/agents/model/editorOptions';
import { INTEGRATION_CATALOG, useUserSettings } from '@/features/integrations';
import { CheckRow, Group, SettingRow, Sheet, Text } from '@/shared/ui';

export function AppsField({ form, disabled }: { form: AgentForm; disabled: boolean }) {
    const t = useTranslation();
    const settings = useUserSettings();
    const [open, setOpen] = useState(false);
    const apps = availableAgentApps(INTEGRATION_CATALOG, settings.data?.orgEnabledIntegrations, settings.isSuccess);
    const enabled = form.draft.config.enabledIntegrations ?? [];
    const title = t('apps.title', 'Apps');
    const on = apps.filter((a) => enabled.includes(a.id)).length;

    return (
        <>
            <Group>
                <SettingRow label={title} value={String(on)} onPress={disabled ? undefined : () => setOpen(true)} />
            </Group>
            <Sheet visible={open} onClose={() => setOpen(false)} title={title} scroll tall>
                {settings.isError ? (
                    <Text variant="caption" tone="warning">
                        {t('mobile.agents.editor.apps_unreadable', 'The organisation’s app list could not be read, so only the built-in tools are offered.')}
                    </Text>
                ) : null}
                <Group>
                    {apps.map((app) => (
                        <CheckRow
                            key={app.id}
                            label={app.label}
                            checked={enabled.includes(app.id)}
                            onToggle={() => form.patchConfig({ enabledIntegrations: toggleId(enabled, app.id) })}
                        />
                    ))}
                </Group>
            </Sheet>
        </>
    );
}
