/**
 * Documents.
 *
 * There is no single "documents" table on this server, and pretending there is
 * would be the wrong shape. Two genuinely different things are gathered here,
 * and the tabs say which is which:
 *
 *   Indexed   — rows in `documents`, always owned by a knowledge base. There is
 *               no cross-base endpoint, so the list is assembled by fanning out
 *               over the bases you can reach — bounded, and tolerant of one
 *               base failing.
 *   Generated — PDFs the document-renderer produced. They expire, and offer
 *               exactly what exists: open and share.
 *
 * Uploading needs a destination, because ingestion is per knowledge base. When
 * the list is filtered to one base that IS the destination; when it is not,
 * the destination is asked for before the picker opens rather than guessed.
 */

import { Stack } from 'expo-router';
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { IngestSheets, KbChunkPreview, useKbIngestFlow } from '@/features/knowledge';
import { Icon, IconButton, Screen, ScreenHeader, ScreenTabs, SearchField } from '@/shared/ui';

import { DeleteDocumentSheet } from '../components/DeleteDocumentSheet';
import { DestinationSheet } from '../components/DestinationSheet';
import { GeneratedDocumentList } from '../components/GeneratedDocumentList';
import { IndexedDocumentList } from '../components/IndexedDocumentList';
import { KbFilterChips } from '../components/KbFilterChips';
import { RenderedDocumentSheet } from '../components/RenderedDocumentSheet';
import { useRenderedDocuments } from '../hooks/queries';
import { useIndexedDocuments } from '../hooks/useIndexedDocuments';
import type { OwnedDocument, RenderedDocument } from '../model/types';

/** Indexed or Generated: the two different things this screen gathers. */
type DocumentTab = 'indexed' | 'generated';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({ search: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm } });

/**
 * `?open=<id>` names a document to open once the list holding it arrives.
 * DERIVED, not set from an effect: an effect would be a setState cascade the
 * React Compiler rejects, and would race the list's own loading.
 * `dismissed` lets the person close a sheet the URL still asks for.
 */
function useAutoOpen(openId: string | undefined, documents: OwnedDocument[] | undefined) {
    const [dismissed, setDismissed] = useState(false);
    const doc = !dismissed && openId ? (documents?.find((d) => d.id === openId) ?? null) : null;
    return { doc, dismiss: () => setDismissed(true) };
}

export function DocumentsScreen({ openId }: { openId?: string }) {
    const theme = useTheme();
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [tab, setTab] = useState<DocumentTab>('indexed');
    const [search, setSearch] = useState('');
    const [filterKbId, setFilterKbId] = useState<string | null>(null);
    // Where the next upload goes. Apart from the filter: the queue resolves
    // its target at upload time, and changing the filter mid-queue must not
    // redirect a file that is already in flight.
    const [destinationKbId, setDestinationKbId] = useState<string | null>(null);
    const [pickingDestination, setPickingDestination] = useState(false);
    const [previewOf, setPreviewOf] = useState<OwnedDocument | null>(null);
    const [openingFile, setOpeningFile] = useState<RenderedDocument | null>(null);
    const [pendingDelete, setPendingDelete] = useState<OwnedDocument | null>(null);

    const data = useIndexedDocuments(filterKbId, search);
    const generated = useRenderedDocuments(tab === 'generated');
    const flow = useKbIngestFlow(destinationKbId ?? '');
    const auto = useAutoOpen(openId, data.indexed.data?.documents);
    const preview = previewOf ?? auto.doc;
    const bases = data.bases.data ?? [];

    /** Start the add flow, asking where to put it if that is not yet settled. */
    const startAdd = () => {
        const target = filterKbId ?? destinationKbId;
        if (!target) {
            setPickingDestination(true);
            return;
        }
        setDestinationKbId(target);
        flow.setAddOpen(true);
    };

    return (
        <Screen edges={['top', 'bottom']}>
            <Stack.Screen options={{ headerShown: false }} />
            <ScreenHeader
                title={t('mobile.kb_documents.title', 'Documents')}
                actions={
                    tab === 'indexed' ? (
                        <IconButton
                            icon={<Icon name="Plus" size={20} color={theme.colors.textPrimary} />}
                            accessibilityLabel={t('mobile.kb_documents.add', 'Add a document')}
                            onPress={startAdd}
                        />
                    ) : null
                }
            />
            <ScreenTabs
                value={tab}
                onChange={setTab}
                options={[
                    { value: 'indexed', label: t('mobile.kb_documents.indexed', 'Indexed') },
                    { value: 'generated', label: t('mobile.kb_documents.generated', 'Generated') },
                ]}
            />
            <View style={styles.search}>
                <SearchField value={search} onChangeText={setSearch} placeholder={t('mobile.kb_documents.search', 'Search documents')} />
            </View>

            {tab === 'indexed' ? (
                <>
                    <KbFilterChips bases={bases} selected={filterKbId} onSelect={setFilterKbId} />
                    <IndexedDocumentList
                        data={data}
                        uploads={flow.uploads}
                        searching={Boolean(search)}
                        onOpen={setPreviewOf}
                        onDelete={setPendingDelete}
                        onAdd={startAdd}
                    />
                </>
            ) : (
                <GeneratedDocumentList generated={generated} search={search} onOpen={setOpeningFile} />
            )}

            <DestinationSheet
                visible={pickingDestination}
                bases={bases}
                onClose={() => setPickingDestination(false)}
                onPick={(kbId) => {
                    setDestinationKbId(kbId);
                    setPickingDestination(false);
                    flow.setAddOpen(true);
                }}
            />
            <IngestSheets
                flow={flow}
                title={t('mobile.kb_documents.add', 'Add a document')}
                subtitle={bases.find((kb) => kb.id === destinationKbId)?.name}
                accepts="PDF, Word, Excel, CSV or text · up to 20 MB"
            />
            <KbChunkPreview
                doc={preview ? { kbId: preview.kbId, docId: preview.id, title: preview.title } : null}
                subtitle={preview?.kbName}
                onClose={() => {
                    setPreviewOf(null);
                    auto.dismiss();
                }}
            />
            <RenderedDocumentSheet doc={openingFile} onClose={() => setOpeningFile(null)} />
            <DeleteDocumentSheet doc={pendingDelete} onDone={() => setPendingDelete(null)} />
        </Screen>
    );
}
