/**
 * The rail as phone lists (web: mobile/MobileRailList): one group per rail
 * group, a row per visible section with the web's description under its name
 * and the counts' meta (a score, what is open) at the right. A meta the
 * counts did not state renders nothing.
 */

import { useRouter } from 'expo-router';
import React from 'react';

import { useTranslation } from '@/core/i18n';
import { Badge, Group, NavRow, Text } from '@/shared/ui';

import { rowMeta, type ComplianceCounts } from '../model/counts';
import { labelText } from '../model/fields';
import { sectionRoute } from '../model/navigation';
import { SECTION_DESCRIPTIONS } from '../model/sectionDescriptions';
import { GROUPS, sectionsInGroup, visibleSections, type SectionGroup } from '../model/sections';

export interface SectionRowsProps {
    groups: readonly SectionGroup[];
    counts: ComplianceCounts | null | undefined;
    enabled: ReadonlySet<string>;
    showTitles?: boolean;
}

export function SectionRows({ groups, counts, enabled, showTitles = false }: SectionRowsProps) {
    const t = useTranslation();
    const router = useRouter();
    const scored = new Set(Object.keys(counts?.scores ?? {}));
    return (
        <>
            {groups.map((groupId) => {
                const group = GROUPS.find((g) => g.id === groupId);
                const rows = visibleSections(sectionsInGroup(groupId), scored, enabled);
                if (!rows.length) return null;
                return (
                    <Group key={groupId} title={showTitles && group ? labelText(group.label, t) : undefined}>
                        {rows.map((section) => {
                            const meta = rowMeta(section, counts, t);
                            const description = SECTION_DESCRIPTIONS[section.id];
                            return (
                                <NavRow
                                    key={section.id}
                                    testID={`section-${section.id}`}
                                    icon={section.icon}
                                    label={labelText(section.label, t)}
                                    description={description ? labelText(description, t) : undefined}
                                    trailing={
                                        meta?.tone ? (
                                            <Badge label={meta.text} tone={meta.tone} />
                                        ) : meta ? (
                                            <Text variant="caption" tone="tertiary">{meta.text}</Text>
                                        ) : undefined
                                    }
                                    onPress={() => router.push(sectionRoute(section.id))}
                                />
                            );
                        })}
                    </Group>
                );
            })}
        </>
    );
}
