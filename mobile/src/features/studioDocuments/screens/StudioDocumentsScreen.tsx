/**
 * Studio Documents — invoices, quotes, letters and presentations, laid out
 * for paper and downloadable as PDF (the web's DocumentsPage).
 *
 * The same library views as the web (documents, templates, reusable
 * sections), the same format filter, and a server-side search. A row opens
 * the editor; its overflow duplicates or archives it; "New document" opens
 * the starter gallery. Folders, bulk moves and categories stay on the web.
 */

import { useRouter } from 'expo-router';
import React, { createContext, useContext, useState } from 'react';
import { StyleSheet, View, type ListRenderItem } from 'react-native';

import { useLocale, useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { QueryList } from '@/shared/patterns';
import { FilterPills, Icon, IconButton, Screen, ScreenHeader, Segmented } from '@/shared/ui';

import { DocumentRow } from '../components/DocumentRow';
import { NewDocumentSheet } from '../components/NewDocumentSheet';
import { RowActions } from '../components/RowActions';
import { useCreateStudioDocument } from '../hooks/mutations';
import { useStudioDocumentPages } from '../hooks/queries';
import { useDebounced } from '../hooks/useDebounced';
import { createRequestFor, type StarterChoice } from '../model/create';
import { kindTabLabel } from '../model/format';
import { DOC_KINDS, type DocKind, type DocumentFilters, type StudioDocumentRow } from '../model/types';

const styles = StyleSheet.create({ controls: { paddingHorizontal: 16, paddingBottom: 8, gap: 8 } });

interface RowHandlers {
    open: (row: StudioDocumentRow) => void;
    more: (row: StudioDocumentRow) => void;
}
const RowContext = createContext<RowHandlers>({ open: () => undefined, more: () => undefined });

function ContextRow({ row }: { row: StudioDocumentRow }) {
    const { open, more } = useContext(RowContext);
    return <DocumentRow row={row} onOpen={open} onMore={more} />;
}
const renderRow: ListRenderItem<StudioDocumentRow> = ({ item }) => <ContextRow row={item} />;
const keyOf = (row: StudioDocumentRow) => row.id;

function useLibraryFilters() {
    const [kind, setKind] = useState<DocKind>('document');
    const [format, setFormat] = useState<DocumentFilters['format']>('');
    const [search, setSearch] = useState('');
    const query = useDebounced(search);
    return { kind, setKind, format, setFormat, search, setSearch, filters: { kind, format, query } };
}

function useNewDocument(kind: DocKind, startOpen: boolean) {
    const t = useTranslation();
    const { locale } = useLocale();
    const router = useRouter();
    const [open, setOpen] = useState(startOpen);
    const create = useCreateStudioDocument({
        onSuccess: (doc) => {
            setOpen(false);
            if (doc) router.push(`/documents/${doc.id}`);
        },
    });
    const pick = (choice: StarterChoice) => {
        const names = {
            page: t('documents.untitled', 'Untitled document'),
            deck: t('mobile.studio_documents.untitled_presentation', 'Untitled presentation'),
        };
        create.mutate(createRequestFor(choice, { kind, locale }, names));
    };
    return { open, setOpen, pick, create, locale };
}

/** `startCreating` opens the starter gallery at once: the Studio New menu's `/documents?new=1`. */
export function StudioDocumentsScreen({ startCreating }: { startCreating?: boolean }) {
    const t = useTranslation();
    const theme = useTheme();
    const router = useRouter();
    const library = useLibraryFilters();
    const pages = useStudioDocumentPages(library.filters);
    const creator = useNewDocument(library.kind, startCreating === true);
    const [menuFor, setMenuFor] = useState<StudioDocumentRow | null>(null);
    const handlers: RowHandlers = { open: (row) => router.push(`/documents/${row.id}`), more: setMenuFor };

    return (
        <Screen edges={['top', 'bottom']}>
            <ScreenHeader
                title={t('documents.title', 'Documents')}
                subtitle={t('mobile.studio_documents.subtitle', 'Documents and presentations. Design once. Adapt to every customer.')}
                actions={
                    <IconButton
                        icon={<Icon name="Plus" size={20} color={theme.colors.textPrimary} />}
                        accessibilityLabel={t('documents.new', 'New document')}
                        onPress={() => creator.setOpen(true)}
                    />
                }
            />
            <View style={styles.controls}>
                <Segmented
                    options={DOC_KINDS.map((kind) => ({ value: kind, label: kindTabLabel(t, kind) }))}
                    value={library.kind}
                    onChange={library.setKind}
                    fullWidth
                    accessibilityLabel={t('mobile.studio_documents.views', 'Library views')}
                />
                <FilterPills
                    value={library.format === '' ? 'all' : library.format}
                    onChange={(next) => library.setFormat(next === 'all' ? '' : next)}
                    options={[
                        { value: 'all', label: t('mobile.studio_documents.format.all', 'Pages & presentations') },
                        { value: 'page', label: t('mobile.studio_documents.format.pages', 'Pages') },
                        { value: 'presentation', label: t('mobile.studio_documents.presentations', 'Presentations') },
                    ]}
                    accessibilityLabel={t('mobile.studio_documents.format.label', 'Document type')}
                />
            </View>
            <RowContext.Provider value={handlers}>
                <QueryList
                    query={{ ...pages, data: pages.rows }}
                    keyExtractor={keyOf}
                    renderItem={renderRow}
                    search={{ placeholder: t('mobile.studio_documents.search', 'Search documents…'), value: library.search, onChange: library.setSearch }}
                    listProps={{ onEndReached: () => void (pages.hasNextPage && !pages.isFetchingNextPage && pages.fetchNextPage()), onEndReachedThreshold: 0.5 }}
                    empty={{
                        icon: 'FileText',
                        title: t('documents.empty_title', 'No documents yet'),
                        message: t('mobile.studio_documents.empty', 'No documents here yet. Start from a template or create your own.'),
                        actionLabel: t('documents.new', 'New document'),
                        onAction: () => creator.setOpen(true),
                    }}
                    noMatch={{ title: t('mobile.studio_documents.no_match', 'No document matches that'), clearLabel: t('automations.mapping.clear_search', 'Clear search') }}
                />
            </RowContext.Provider>
            <NewDocumentSheet
                visible={creator.open}
                locale={creator.locale}
                busy={creator.create.isPending}
                error={creator.create.error}
                onClose={() => creator.setOpen(false)}
                onPick={creator.pick}
            />
            <RowActions row={menuFor} onClose={() => setMenuFor(null)} onOpen={handlers.open} />
        </Screen>
    );
}
