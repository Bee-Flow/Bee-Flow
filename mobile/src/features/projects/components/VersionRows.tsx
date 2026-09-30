/**
 * The rows of the Versions tab: one entity line of a release note (its name,
 * the one-line summary when there is one, and the honest "no summary could be
 * written" when there is not), and one published version in the list.
 */

import React from 'react';

import { timeAgo, useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, KindTile, ListRow, Text, kindOf } from '@/shared/ui';

import { GlyphRow } from './GlyphRow';
import type { NoteRow, Release } from '../model/package';
import { changesIn } from '../model/releases';
import { byCount } from '../model/words';

export function NoteLine({ row }: { row: NoteRow }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const kind = kindOf(row.kind);
    return (
        <GlyphRow
            glyph={kind ? <KindTile kind={kind} size={22} /> : <Icon name="Package" size={16} color={styles.muted.color} />}
            text={row.name}
            dense
            testID="version-note-row"
        >
            {row.text ? (
                <Text variant="caption" tone="secondary">
                    {row.text}
                </Text>
            ) : null}
            {row.summaryMissing ? (
                <Text variant="caption" tone="tertiary">
                    {t('solutions.release_no_summary', 'Changed — a one-line summary could not be written for this one.')}
                </Text>
            ) : null}
        </GlyphRow>
    );
}

export function VersionLine({ release, selected, onSelect }: { release: Release; selected: boolean; onSelect: (id: string) => void }) {
    const t = useTranslation();
    const changes = changesIn(release);
    const p = { count: changes ?? 0 };
    return (
        <ListRow
            title={
                release.version === null
                    ? t('solutions.release_version_unknown', 'Version unknown')
                    : t('solutions.release_version', 'v{version}', { version: release.version })
            }
            subtitle={release.publishedAt ? timeAgo(release.publishedAt, { suffix: true }) : undefined}
            meta={
                changes === null
                    ? t('solutions.release_row_unrecorded', 'not recorded')
                    : byCount(changes, t('solutions.release_row_changes', '{count} change', p), t('solutions.release_row_changes_plural', '{count} changes', p))
            }
            selected={selected}
            onPress={() => onSelect(release.id)}
            testID="version-row"
        />
    );
}

const makeStyles = (theme: Theme) => ({
    muted: { color: theme.colors.textTertiary },
});
