/**
 * One Nextcloud group's exceptions (OrgNcIntegrationsPanel "Per-group
 * exceptions"): switch a tool off for this group only. A tool the
 * organisation has off cannot be switched here. Each switch saves at once.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { NoteRow, Sheet, ToggleRow } from '@/shared/ui';

import type { NcCatalogItem, NcIntegrationGroup } from '../model/types';

export function NcGroupSheet({
    group,
    catalog,
    orgEnabled,
    onToggle,
    onClose,
}: {
    group: NcIntegrationGroup | null;
    catalog: readonly NcCatalogItem[];
    orgEnabled: readonly string[];
    onToggle: (group: NcIntegrationGroup, toolId: string) => void;
    onClose: () => void;
}) {
    const t = useTranslation();
    return (
        <Sheet
            visible={group !== null}
            onClose={onClose}
            title={group?.name ?? ''}
            subtitle={t('mobile.orgIntegrations.nc_group_sheet_hint', 'Tools switched on here are blocked for members of this group. Changes save immediately.')}
        >
            {group
                ? catalog.map((tool) => {
                      const orgOn = orgEnabled.includes(tool.id);
                      return (
                          <ToggleRow
                              key={tool.id}
                              testID={`nc-group-${tool.id}`}
                              gutter={false}
                              label={t('mobile.orgIntegrations.nc_disable', 'Disable {name}', { name: tool.name })}
                              description={orgOn ? undefined : t('mobile.orgIntegrations.nc_enable_first', 'Enable org-wide first')}
                              value={group.disabledIntegrations.includes(tool.id)}
                              disabled={!orgOn}
                              onValueChange={() => onToggle(group, tool.id)}
                          />
                      );
                  })
                : null}
            <NoteRow>
                {t(
                    'mobile.orgIntegrations.nc_enable_wins',
                    'A member keeps a tool as long as at least one of their groups still allows it.',
                )}
            </NoteRow>
        </Sheet>
    );
}
