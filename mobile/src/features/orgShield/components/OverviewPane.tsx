/**
 * "How does this organisation stand right now?" — the master switch, the
 * banners, the derived posture and who last saved the policy.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { absoluteDate } from '@/shared/lib/display';
import { Group, GroupedScroll, NoteRow, Text, ToggleRow } from '@/shared/ui';

import { PostureGroup } from './PostureGroup';
import { ShieldBanners } from './ShieldBanners';
import type { Posture, PostureTab } from '../model/posture';
import type { GuardStatus, ShieldDoc, ShieldFields } from '../model/types';

export function OverviewPane({
    doc,
    fields,
    guard,
    posture,
    set,
    onGoTo,
}: {
    doc: ShieldDoc;
    fields: ShieldFields;
    guard: GuardStatus | null | undefined;
    posture: Posture;
    set: (changes: Partial<ShieldFields>) => void;
    onGoTo: (tab: PostureTab) => void;
}) {
    const t = useTranslation();
    return (
        <GroupedScroll>
            <ShieldBanners doc={doc} guard={guard} />
            <Group>
                <ToggleRow
                    label={t('admin.shield_enable', 'Protect personal data')}
                    description={t('admin.shield_enable_desc_strong', 'Applies to every chat and every agent in this organisation. Off means nothing is checked, at all.')}
                    value={fields.enabled}
                    onValueChange={(enabled) => set({ enabled })}
                    testID="shield-enabled"
                />
            </Group>
            <PostureGroup posture={posture} onGoTo={onGoTo} />
            <Group>
                <NoteRow>
                    <Text variant="caption" tone="secondary">
                        {t('admin.shield_how_it_works_desc', 'These rules run first, before any rules set on an individual agent. An agent can be stricter, never looser — if the two disagree, the stricter one wins.')}
                    </Text>
                </NoteRow>
                {doc.updatedAt ? (
                    <NoteRow>
                        <Text variant="caption" tone="tertiary">
                            {t('mobile.orgShield.last_saved', 'Last saved {when} by {who}', {
                                when: absoluteDate(doc.updatedAt),
                                who: doc.updatedBy ?? '—',
                            })}
                        </Text>
                    </NoteRow>
                ) : null}
            </Group>
        </GroupedScroll>
    );
}
