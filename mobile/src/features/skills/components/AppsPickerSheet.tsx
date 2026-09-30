/**
 * "Browse apps…" — which apps' tools become available while the skill is
 * active (`enabled_integrations`). The catalogue is filtered by what the org
 * allows (model/apps availableApps); a switch per app, as the web's
 * AppsPicker has.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { Sheet, Text, ToggleRow } from '@/shared/ui';

export function AppsPickerSheet({
    visible,
    onClose,
    apps,
    enabled,
    narrowed,
    onToggle,
}: {
    visible: boolean;
    onClose: () => void;
    apps: readonly { id: string; label: string; description: string }[];
    enabled: readonly string[];
    /** True when the org's list could not be read and only built-ins are shown. */
    narrowed: boolean;
    onToggle: (id: string) => void;
}) {
    const t = useTranslation();
    return (
        <Sheet visible={visible} onClose={onClose} title={t('skills_studio.canuse.browse_apps', 'Browse apps…')} tall>
            {narrowed ? (
                <Text variant="caption" tone="warning">
                    {t(
                        'mobile.skills.apps_narrowed',
                        'Which apps your organisation allows could not be read, so only the built-in tools are offered.',
                    )}
                </Text>
            ) : null}
            {apps.map((app) => (
                <ToggleRow
                    key={app.id}
                    gutter={false}
                    label={app.label}
                    description={app.description}
                    value={enabled.includes(app.id)}
                    onValueChange={() => onToggle(app.id)}
                />
            ))}
        </Sheet>
    );
}
