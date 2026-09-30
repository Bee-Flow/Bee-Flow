/**
 * Choose the knowledge bases the builder searches for this page. Bases that
 * belong to another object (a notebook's, another page's) are not offered;
 * the page's own base is not in the list at all — it is kept, first, by
 * model/knowledgeBases.ts.
 */

import React, { useCallback, useState } from 'react';
import { FlatList } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useKnowledgeBases, type KnowledgeBase } from '@/features/knowledge';
import { Button, OptionRow, Sheet, useToast } from '@/shared/ui';

import { ListFallback } from './ListFallback';
import { useUpdateWebpage } from '../hooks/mutations';
import { attachedKnowledgeBaseIds, nextKnowledgeBaseIds, toggleId } from '../model/knowledgeBases';
import type { Webpage } from '../model/types';

const OWNED_ELSEWHERE = new Set(['notebook', 'webpage']);
const keyOf = (kb: KnowledgeBase) => kb.id;

function PickerBody({ webpage, onClose }: { webpage: Webpage; onClose: () => void }) {
    const t = useTranslation();
    const { toast } = useToast();
    const bases = useKnowledgeBases();
    const [selected, setSelected] = useState(() => attachedKnowledgeBaseIds(webpage));
    const save = useUpdateWebpage(webpage.id, {
        onSuccess: () => {
            toast(t('common.saved', 'Saved'), 'success');
            onClose();
        },
        onError: (err) => toast(describeError(err).message, 'error'),
    });
    const rows = (bases.data ?? []).filter(
        (kb) => !OWNED_ELSEWHERE.has(kb.source_kind ?? '') || selected.includes(kb.id),
    );
    const renderItem = useCallback(
        ({ item }: { item: KnowledgeBase }) => (
            <OptionRow
                label={item.name}
                description={item.description ?? undefined}
                selected={selected.includes(item.id)}
                onPress={() => setSelected((prev) => toggleId(prev, item.id))}
            />
        ),
        [selected],
    );

    const empty = (
        <ListFallback
            query={bases}
            icon="Library"
            title={t('mobile.webpages.settings.no_bases', 'No knowledge bases to add')}
        />
    );

    return (
        <Sheet
            visible
            onClose={onClose}
            title={t('mobile.webpages.settings.bases', 'Knowledge bases')}
            subtitle={t('mobile.webpages.settings.bases_hint', 'The builder searches these on every turn')}
            scroll={false}
            tall
            footer={
                <Button
                    label={t('common.save', 'Save')}
                    size="lg"
                    fullWidth
                    loading={save.isPending}
                    onPress={() => save.mutate({ knowledgeBaseIds: nextKnowledgeBaseIds(webpage, selected) })}
                />
            }
        >
            <FlatList
                data={rows}
                keyExtractor={keyOf}
                renderItem={renderItem}
                ListEmptyComponent={empty}
                extraData={selected}
            />
        </Sheet>
    );
}

export function KbPickerSheet({
    webpage,
    visible,
    onClose,
}: {
    webpage: Webpage;
    visible: boolean;
    onClose: () => void;
}) {
    // Mounted per opening, so the selection starts from what is saved.
    return visible ? <PickerBody webpage={webpage} onClose={onClose} /> : null;
}
