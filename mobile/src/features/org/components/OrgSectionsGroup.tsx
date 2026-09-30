/** One group of the organisation index: its sections, each with an optional value. */

import { useRouter } from 'expo-router';
import React from 'react';

import { useTranslation } from '@/core/i18n';
import { Group, SettingRow } from '@/shared/ui';

import { SectionTile } from './SectionTile';
import type { OrgSection, OrgSectionId } from '../model/sections';

/** What a row says on its right: the tier on the licence row, the website on Info. */
export interface SectionValue {
    text: string;
    /** Draws the warning glyph instead of the section's own. */
    warning?: boolean;
}

export type SectionValues = Partial<Record<OrgSectionId, SectionValue>>;

export function OrgSectionsGroup({
    title,
    sections,
    values,
}: {
    title: string;
    sections: readonly OrgSection[];
    values?: SectionValues;
}) {
    const router = useRouter();
    const t = useTranslation();
    if (sections.length === 0) return null;
    return (
        <Group title={title}>
            {sections.map((section) => {
                const value = values?.[section.id];
                return (
                    <SettingRow
                        key={section.id}
                        testID={`org-section-${section.id}`}
                        label={t(section.labelKey, section.label)}
                        value={value?.text}
                        icon={<SectionTile section={section} warning={value?.warning} />}
                        onPress={() => router.push(section.href as never)}
                    />
                );
            })}
        </Group>
    );
}
