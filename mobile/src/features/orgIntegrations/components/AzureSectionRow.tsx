/** One section of the Azure hub (the web panel's sub-section list), with its status chip. */

import React from 'react';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { Badge, Icon, ListRow } from '@/shared/ui';

import { AZURE_TIERS, sectionStatus, type AzureSection } from '../model/azure';
import type { AzureConfig } from '../model/azureTypes';

function statusChip(status: ReturnType<typeof sectionStatus>, t: TranslateFn) {
    if (status === null) return undefined;
    if (typeof status === 'number') {
        return <Badge label={`${status}/${AZURE_TIERS.length} ${t('azure.tiers', 'tiers')}`} tone="success" icon="Check" />;
    }
    if (status === 'configured') return <Badge label={t('azure.configured', 'Configured')} tone="success" icon="Check" />;
    if (status === 'partial') return <Badge label={t('azure.partial', 'Partial')} tone="warning" icon="TriangleAlert" />;
    return <Badge label={t('azure.not_configured', 'Not configured')} tone="error" icon="TriangleAlert" />;
}

export function AzureSectionRow({ section, config, onPress }: { section: AzureSection; config: AzureConfig; onPress: () => void }) {
    const t = useTranslation();
    return (
        <ListRow
            testID={`azure-${section.id}`}
            title={t(section.labelKey, section.english[0])}
            subtitle={t(section.descKey, section.english[1])}
            leading={<Icon name={section.icon} size={18} color={section.color} />}
            trailing={statusChip(sectionStatus(section.id, config), t)}
            chevron
            onPress={onPress}
        />
    );
}
