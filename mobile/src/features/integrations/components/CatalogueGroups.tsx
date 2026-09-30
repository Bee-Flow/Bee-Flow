/**
 * What the model may use, one group per category. The catalogue is the fixed
 * list mirrored from the web, narrowed by the organisation — bounded data, so
 * plain groups rather than a virtualised list.
 */

import React from 'react';

import { Group, ToggleRow } from '@/shared/ui';

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
    return (
        <>
            {categories.map((category) => (
                <Group
                    key={category}
                    title={category}
                    footer={
                        category === 'Nextcloud'
                            ? 'Nextcloud tools work through your organisation’s Nextcloud binding rather than a personal connection.'
                            : undefined
                    }
                >
                    {catalogue
                        .filter((entry) => entry.category === category)
                        .map((entry) => (
                            <ToggleRow
                                key={entry.id}
                                label={entry.label}
                                description={entry.description}
                                value={enabled.has(entry.id)}
                                onValueChange={() => onToggle(entry.id)}
                            />
                        ))}
                </Group>
            ))}
        </>
    );
}
