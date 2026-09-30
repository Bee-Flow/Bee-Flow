/**
 * Content — what is in this Solution, in three bands: what people use, where
 * work happens, and the knowledge and data both read from (the web's
 * SolutionContentTable). One block per row, so a big Solution is virtualised.
 *
 * `null` from the server means that store could not be read, and it is said —
 * "could not load" and "none filed" are different facts, and a page that
 * conflates them tells someone their work is gone. The same goes for the
 * listing itself: a failed read is an error with a retry, never a spinner.
 */

import React, { useState } from 'react';

import { describeError } from '@/core/api/errors';
import { useCurrentUser } from '@/core/auth/AuthProvider';
import { useTranslation, type TranslateFn } from '@/core/i18n';
import { cardRows, useConfirm, type Block } from '@/shared/patterns';
import { Button, ErrorState, LoadingState, Text, useToast } from '@/shared/ui';

import { AddResourceSheet } from './AddResourceSheet';
import { ContentItemRow } from './ContentItemRow';
import { Strip } from './Strip';
import { block, TabBlocks } from './TabBlocks';
import { useFileResource } from '../hooks/mutations';
import { useProjectGraph } from '../hooks/solutionQueries';
import { useOpenLink } from '../hooks/useOpenLink';
import type { SolutionState } from '../hooks/useSolution';
import { contentBands, type BandContent, type ContentRow } from '../model/content';
import { bandLabel, filedKeys, itemLabel, sectionLabel } from '../model/sections';

type RowHandlers = { onOpen: (row: ContentRow) => void; onRemove: (row: ContentRow) => void };

function bandBlocks(band: BandContent, handlers: RowHandlers, t: TranslateFn): Block[] {
    const blocks: Block[] = [
        block(`band:${band.band}`, () => (
            <Text variant="label" tone="tertiary">
                {bandLabel(band.band, t).toUpperCase()}
            </Text>
        )),
    ];
    for (const s of band.sections) {
        if (s.state === 'unavailable') {
            const label = sectionLabel(s.section.key, t);
            blocks.push(
                block(
                    `unavailable:${s.section.key}`,
                    () => (
                        <Strip tone="warning" testID={`section-unavailable-${s.section.key}`}>
                            {`${label} — ${t('projects.section_unavailable', 'Could not load this section. Your items are safe — try again shortly.')}`}
                        </Strip>
                    ),
                    'inner',
                ),
            );
        } else if (s.rows.length > 0) {
            blocks.push(
                ...cardRows({
                    key: `rows:${s.section.key}`,
                    rows: s.rows,
                    rowKey: (row) => row.item.id,
                    render: (row) => <ContentItemRow row={row} onOpen={handlers.onOpen} onRemove={handlers.onRemove} />,
                }),
            );
        }
    }
    if (band.empty) {
        blocks.push(block(`empty:${band.band}`, () => <Strip tone="quiet">{t('projects.section_empty', 'Nothing here yet.')}</Strip>, 'inner'));
    }
    return blocks;
}

/** Take something back out, after saying what that does. */
function useRemove(projectId: string) {
    const t = useTranslation();
    const confirm = useConfirm();
    const { toast } = useToast();
    const file = useFileResource(projectId);
    return async (row: ContentRow) => {
        const ok = await confirm({
            title: t('projects.remove_from_project', 'Remove from project'),
            message: t('mobile.projects.remove_message', '"{name}" leaves this Solution. It is not deleted — it stays yours.', {
                name: itemLabel(row.item) ?? t('solutions.depends_unnamed', 'Untitled'),
            }),
            confirmLabel: t('common.remove', 'Remove'),
        });
        if (!ok) return;
        file.mutate(
            { kind: row.section.kind, itemId: row.item.id, attach: false },
            { onError: (err) => toast(describeError(err).message, 'error') },
        );
    };
}

export function ContentTab({ id, sol }: { id: string; sol: SolutionState }) {
    const t = useTranslation();
    const me = useCurrentUser();
    const openLink = useOpenLink();
    const graph = useProjectGraph(id);
    const remove = useRemove(id);
    const [adding, setAdding] = useState(false);
    const resources = sol.resources.data;
    if (!resources) {
        // Spin only while the listing is on its way. A failed read (or an
        // answer that is not a listing) says so, with a way to ask again.
        if (sol.resources.isLoading) return <LoadingState />;
        const error = sol.resources.error ?? new Error(t('mobile.projects.content_not_loaded', 'What is in this Solution could not be loaded.'));
        return <ErrorState error={error} onRetry={() => void sol.resources.refetch()} />;
    }

    const bands = contentBands({
        resources,
        graph: graph.data,
        completeness: sol.completeness.isError ? null : sol.completeness.data,
        meId: me?.id,
        canEdit: sol.canEdit,
    });
    const handlers: RowHandlers = {
        onOpen: (row) => openLink(row.section.webPath(row.item.id)),
        onRemove: (row) => void remove(row),
    };
    const blocks: Block[] = [
        ...(sol.canEdit
            ? [
                  block('add', () => (
                      <Button label={t('projects.add_existing', 'Add existing')} iconName="Plus" variant="secondary" size="sm" onPress={() => setAdding(true)} testID="content-add" />
                  )),
              ]
            : []),
        ...bands.flatMap((band) => bandBlocks(band, handlers, t)),
    ];

    return (
        <>
            <TabBlocks
                blocks={blocks}
                onRefresh={() => Promise.all([sol.resources.refetch(), graph.refetch(), sol.completeness.refetch()])}
            />
            <AddResourceSheet projectId={id} visible={adding} filed={filedKeys(resources)} onClose={() => setAdding(false)} />
        </>
    );
}
