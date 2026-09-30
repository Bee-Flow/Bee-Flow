/**
 * One notebook: Sources · Notes · Chat, the web's three panes switched rather
 * than side by side, because a phone has room for one.
 *
 * Adding a source returns 200 immediately and the extraction, chunking and
 * embedding happen on a worker (routes/notebooks.js), so the notebook polls
 * while anything is in flight and every row says which stage it is at.
 *
 * The notes draft lives here, above the tabs, so switching to the chat and
 * back never drops an edit, and an answer inserted from the chat lands in the
 * same draft the Notes tab shows.
 */

import { Stack } from 'expo-router';
import React, { useMemo, useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { useConfirmLeave } from '@/shared/patterns';
import { Screen, ScreenHeader, ScreenTabs } from '@/shared/ui';

import { NotebookChatTab } from '../components/NotebookChatTab';
import { NotebookHeaderActions } from '../components/NotebookHeaderActions';
import { NotebookNotesTab } from '../components/NotebookNotesTab';
import { NotebookSheets, useNotebookSheets } from '../components/NotebookSheets';
import { NotebookSourcesTab } from '../components/NotebookSourcesTab';
import { UploadingBar } from '../components/UploadingBar';
import { useNotebookIngestFlow, useRefreshNotebook } from '../hooks/mutations';
import { useNotebook } from '../hooks/queries';
import { useNoteDraft } from '../hooks/useNoteDraft';
import { isWorking, sourcesLine } from '../model/format';

type NotebookTab = 'sources' | 'notes' | 'chat';

export function NotebookScreen({ notebookId }: { notebookId: string }) {
    const t = useTranslation();
    const [tab, setTab] = useState<NotebookTab>('sources');
    const sheets = useNotebookSheets();

    const query = useNotebook(notebookId);
    const notebook = query.data?.notebook ?? null;
    const sources = useMemo(() => query.data?.sources ?? [], [query.data]);
    const refresh = useRefreshNotebook(notebookId);
    const flow = useNotebookIngestFlow(notebookId);
    const draft = useNoteDraft(notebookId, notebook);
    // A save that failed is the one thing leaving would lose; an edit still
    // waiting for its pause is saved on the way out (useNoteDraft).
    useConfirmLeave(draft.status === 'error');

    const readyCount = sources.filter((s) => s.status === 'ready').length;
    const workingCount = sources.filter(isWorking).length;
    const name = notebook?.name ?? null;

    return (
        <Screen edges={['top', 'bottom']} avoidKeyboard>
            <Stack.Screen options={{ headerShown: false }} />
            <ScreenHeader
                title={name ?? t('notebooks.title', 'Notebooks')}
                subtitle={sourcesLine(sources)}
                onPressTitle={() => sheets.setRenaming(name !== null)}
                actions={
                    <NotebookHeaderActions
                        notebookId={notebookId}
                        name={name}
                        onAdd={() => flow.setAddOpen(true)}
                        onRename={() => sheets.setRenaming(true)}
                        onDelete={() => sheets.setDeleting(true)}
                    />
                }
            />
            <ScreenTabs
                value={tab}
                onChange={setTab}
                options={[
                    { value: 'sources', label: t('notebooks.sources', 'Sources') },
                    { value: 'notes', label: t('notebooks.notes', 'Notes') },
                    { value: 'chat', label: t('notebooks.chat', 'Chat') },
                ]}
            />

            {tab === 'sources' ? (
                <NotebookSourcesTab
                    notebookId={notebookId}
                    query={query}
                    sources={sources}
                    uploads={flow.uploads}
                    onPreview={sheets.setPreviewOf}
                    onDelete={sheets.setRemoving}
                    onRename={sheets.setRenamingSource}
                    onAdd={() => flow.setAddOpen(true)}
                />
            ) : null}
            {tab === 'notes' ? <NotebookNotesTab draft={draft} /> : null}
            {tab === 'chat' ? (
                <NotebookChatTab
                    notebookId={notebookId}
                    documentContent={draft.editable ? draft.text : (notebook?.documentContent ?? '')}
                    readyCount={readyCount}
                    workingCount={workingCount}
                    onNotebookChanged={refresh}
                    onInsertAnswer={draft.editable ? draft.append : undefined}
                />
            ) : null}

            <NotebookSheets notebookId={notebookId} notebook={notebook} flow={flow} sheets={sheets} />
            {flow.uploads.active && tab !== 'sources' ? <UploadingBar onPress={() => setTab('sources')} /> : null}
        </Screen>
    );
}
