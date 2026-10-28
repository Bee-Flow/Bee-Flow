/**
 * What the model may use, one group per category. The catalogue is the fixed
 * list mirrored from the web, narrowed by the organisation — bounded data, so
 * plain groups rather than a virtualised list.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { Group, ToggleRow } from '@/shared/ui';

import { categoryCopy } from '../model/catalog';
import type { CatalogEntry } from '../model/types';

export function CatalogueGroups({
    catalogue,
    categories,
    enabled,
    onToggle,
}: {
    catalogue: CatalogEntry[];
    categories: string[];
    enabled: ReadonlySet<string>;
    onToggle: (id: string) => void;
}) {
    const t = useTranslation();
    return (
        <>
            {categories.map((category) => {
                const heading = categoryCopy(category);
                return (
                    <Group
                        key={category}
                        title={heading ? t(heading.i18nKey, heading.en) : category}
                        footer={
                            category === 'Nextcloud'
                                ? t(
                                      'mobile.integrations.nextcloud_footer',
                                      'Nextcloud tools work through your organisation’s Nextcloud binding rather than a personal connection.',
                                  )
                                : undefined
                        }
                    >
                        {catalogue
                            .filter((entry) => entry.category === category)
                            .map((entry) => (
                                <ToggleRow
                                    key={entry.id}
                                    label={t(entry.labelKey, entry.label)}
                                    description={t(entry.descriptionKey, entry.description)}
                                    value={enabled.has(entry.id)}
                                    onValueChange={() => onToggle(entry.id)}
                                />
                            ))}
                    </Group>
                );
            })}
        </>
    );
}
