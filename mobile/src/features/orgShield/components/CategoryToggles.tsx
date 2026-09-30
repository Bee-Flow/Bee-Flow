/**
 * The 21 kinds of personal data as switches, one group per catalogue group.
 * Serves the detection list and both tool lists: one control, three questions
 * (the web asks them as three columns of one matrix; a phone asks one at a
 * time). The catalogue is fixed at 21, so a plain map is bounded.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { Group, ToggleRow } from '@/shared/ui';

import { PII_GROUP_KEYS, categoriesIn } from '../model/piiCatalog';

export function CategoryToggles({
    selected,
    onToggle,
    disabled = false,
    testPrefix,
}: {
    selected: readonly string[];
    onToggle: (id: string, on: boolean) => void;
    disabled?: boolean;
    testPrefix: string;
}) {
    const t = useTranslation();
    return (
        <>
            {PII_GROUP_KEYS.map((g) => (
                <Group key={g.group} title={t(g.key, g.fallback)}>
                    {categoriesIn(g.group).map((c) => (
                        <ToggleRow
                            key={c.id}
                            label={t(c.i18nKey, c.fallback)}
                            value={selected.includes(c.id)}
                            onValueChange={(on) => onToggle(c.id, on)}
                            disabled={disabled}
                            testID={`${testPrefix}-${c.id}`}
                        />
                    ))}
                </Group>
            ))}
        </>
    );
}
