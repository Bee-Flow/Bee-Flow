/**
 * Versions — this Solution's publication history, two ways (the web's
 * SolutionVersionsTab): WHAT CHANGED in one version, entity by entity, and
 * ALL VERSIONS, where tapping one opens it in the first view.
 *
 * The one-line summaries may be missing (the model that writes them can
 * fail); the diff under them is exact and is always shown. A version with no
 * recorded diff says so — it is not "nothing changed" — and a history that
 * could not be read is not "never published".
 */

import React, { useState } from 'react';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { cardRows, type Block } from '@/shared/patterns';
import { LoadingState, Segmented, Text } from '@/shared/ui';

import { Strip } from './Strip';
import { block, TabBlocks } from './TabBlocks';
import { NoteLine, VersionLine } from './VersionRows';
import { useReleases } from '../hooks/solutionQueries';
import type { NoteRow, Release } from '../model/package';
import { groupNoteRows } from '../model/releases';
import { byCount } from '../model/words';

function noteGroup(key: string, title: string, rows: NoteRow[]): Block[] {
    if (rows.length === 0) return [];
    return [
        block(`${key}:title`, () => <Text variant="subheading">{title}</Text>),
        ...cardRows({ key, rows: rows.map((row, i) => ({ row, i })), rowKey: ({ row, i }) => `${row.ref}-${i}`, render: ({ row }) => <NoteLine row={row} /> }),
    ];
}

function changeBlocks(release: Release, t: TranslateFn): Block[] {
    const entities = release.notes.entities;
    if (entities === null) {
        return [block('unrecorded', () => <Strip tone="warning">{t('solutions.release_unrecorded', 'No record of what changed was kept for this version, so this is not "nothing changed".')}</Strip>)];
    }
    const g = groupNoteRows(entities);
    const c = { count: g.changed.length };
    const a = { count: g.added.length };
    const u = { count: g.unchanged.length };
    const out: Block[] = [];
    if (release.notes.textsDropped) {
        out.push(block('dropped', () => <Strip tone="muted">{t('solutions.release_texts_dropped', 'The written summaries were left out because the note was too large. The list below is still exact.')}</Strip>));
    }
    if (entities.length === 0) {
        out.push(block('empty', () => <Strip tone="muted">{t('solutions.release_carries_nothing', 'This version carries nothing that can be listed.')}</Strip>));
    }
    out.push(
        ...noteGroup('changed', byCount(g.changed.length, t('solutions.release_changed', '{count} thing changed', c), t('solutions.release_changed_plural', '{count} things changed', c)), g.changed),
        ...noteGroup('added', byCount(g.added.length, t('solutions.release_added', '{count} thing is new in this version', a), t('solutions.release_added_plural', '{count} things are new in this version', a)), g.added),
        ...noteGroup('unchanged', byCount(g.unchanged.length, t('solutions.release_unchanged', '{count} thing is unchanged', u), t('solutions.release_unchanged_plural', '{count} things are unchanged', u)), g.unchanged),
    );
    const o = { count: release.notes.omitted };
    const x = { count: g.unreadable };
    if (release.notes.omitted > 0) {
        out.push(block('omitted', () => <Text variant="caption" tone="tertiary">{byCount(o.count, t('solutions.release_omitted', '{count} more entry was left out of the note to keep it within its size limit.', o), t('solutions.release_omitted_plural', '{count} more entries were left out of the note to keep it within its size limit.', o))}</Text>));
    }
    if (g.unreadable > 0) {
        out.push(block('unplaceable', () => <Text variant="caption" tone="tertiary">{byCount(x.count, t('solutions.release_unplaceable', '{count} entry could not be placed and is not counted above.', x), t('solutions.release_unplaceable_plural', '{count} entries could not be placed and are not counted above.', x))}</Text>));
    }
    return out;
}

type VersionsView = 'changes' | 'all';

export function VersionsTab({ id }: { id: string }) {
    const t = useTranslation();
    const releases = useReleases(id, true);
    const [view, setView] = useState<VersionsView>('changes');
    const [picked, setPicked] = useState<string | null>(null);
    if (releases.isLoading) return <LoadingState />;

    const list = releases.data ?? [];
    // The newest is the default — the version "what changed" means.
    const selected = list.find((r) => r.id === picked) ?? list[0] ?? null;
    let blocks: Block[];
    if (releases.isError || !releases.data) {
        blocks = [block('unreadable', () => <Strip tone="error">{t('solutions.release_unavailable', 'The release history could not be read, so this is not "there are none".')}</Strip>)];
    } else if (!selected) {
        blocks = [block('none', () => <Strip tone="muted">{t('solutions.release_none', 'This Solution has not been published yet, so there are no versions.')}</Strip>)];
    } else {
        const switcher = block('view', () => (
            <Segmented<VersionsView>
                value={view}
                onChange={setView}
                options={[
                    { value: 'changes', label: t('solutions.versions_view_changes', 'What changed') },
                    { value: 'all', label: t('solutions.versions_view_all', 'All versions') },
                ]}
            />
        ), 'none');
        const body =
            view === 'changes'
                ? changeBlocks(selected, t)
                : cardRows({
                      key: 'versions',
                      rows: list,
                      rowKey: (r) => r.id,
                      render: (r) => (
                          <VersionLine release={r} selected={r.id === selected.id} onSelect={(next) => { setPicked(next); setView('changes'); }} />
                      ),
                  });
        blocks = [switcher, ...body];
    }
    return <TabBlocks blocks={blocks} onRefresh={() => releases.refetch()} />;
}
