/**
 * What the answer cache holds right now, and the button that forgets it.
 * Expired rows count as stored: the hourly prune deletes them, and until it
 * runs they are still somebody's data in the database (the web's reasoning).
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { Group, NoteRow, SettingRow } from '@/shared/ui';

import { fill, formatBytes } from '../model/format';
import type { OrgIntegrationCache } from '../model/sectionTypes';

export function StoredAnswersGroup({
    cache,
    purging,
    onPurge,
}: {
    cache: OrgIntegrationCache;
    purging: boolean;
    onPurge: (stored: number) => void;
}) {
    const t = useTranslation();
    const stored = cache.entries + cache.expiredEntries;
    if (stored <= 0) return null;
    const held = fill(t('admin.integration_cache.held', 'Stored right now: {{n}} answer(s), {{size}}.'), {
        n: stored,
        size: formatBytes(cache.bytes),
    });
    const expired =
        cache.expiredEntries > 0
            ? ` ${fill(
                  t(
                      'admin.integration_cache.held_expired',
                      '{{n}} of those have already expired and are never served — they are deleted by the hourly clean-up, or by the button below.',
                  ),
                  { n: cache.expiredEntries },
              )}`
            : '';
    return (
        <Group>
            <NoteRow>{`${held}${expired}`}</NoteRow>
            <SettingRow
                testID="cache-purge"
                label={fill(t('admin.integration_cache.clear', 'Delete the {{n}} stored answer(s) now'), { n: stored })}
                destructive
                disabled={purging}
                onPress={() => onPurge(stored)}
            />
        </Group>
    );
}
