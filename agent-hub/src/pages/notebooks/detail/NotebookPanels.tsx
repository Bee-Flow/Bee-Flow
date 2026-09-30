/**
 * The open notebook's side panels, as the view hands them to the workspace
 * shell: the sources rail, the private AI chat, and the overlays (a citation,
 * the signing dialog, the version history drawer).
 */
import React, { useState } from 'react';
import NotebookSources from '../NotebookSources';
import NotebookChat from '../NotebookChat';
import CitationOverlay from '../CitationOverlay';
import SendForSigningModal from '../SendForSigningModal';
import type useSourcesPolling from '../hooks/useSourcesPolling';
import type useNotebookChat from './useNotebookChat';
import type useNotebookExports from './useNotebookExports';


export function NotebookSourcesPanel({ sources, readOnly, showMeetingNotes }: {
    sources: ReturnType<typeof useSourcesPolling>;
    readOnly: boolean;
    showMeetingNotes: boolean;
}) {
    const [dragOver, setDragOver] = useState(false);
    const Sources = NotebookSources as unknown as React.ComponentType<any>;
    return (
        <Sources
            sources={sources.sources}
            readOnly={readOnly}
            onFileUpload={sources.handleFileUpload}
            onAddUrl={sources.handleAddUrl}
            onAddText={sources.handleAddText}
            onAddMeeting={sources.handleAddMeeting}
            onDeleteSource={sources.handleDeleteSource}
            onRetrySource={sources.handleRetrySource}
            onCancelSource={sources.handleCancelSource}
            onRenameSource={sources.handleRenameSource}
            onReorderSources={sources.handleReorderSources}
            onBulkDelete={sources.handleBulkDelete}
            onPreviewSource={sources.fetchSourceContent}
            dragOver={dragOver}
            setDragOver={setDragOver}
            totalWords={sources.totalWords}
            readyCount={sources.readySources.length}
            showMeetingNotes={showMeetingNotes}
            uploads={sources.uploads}
            pendingDelete={sources.pendingDelete}
            onUndoDelete={sources.undoDelete}
            onRetryUpload={sources.retryUpload}
            onDismissUpload={sources.dismissUpload}
        />
    );
}

export function NotebookChatPanel({ chat, modelTiers, selectedTier, onTierChange, readOnly, privateHint, sourceCount, onCitationClick }: {
    chat: ReturnType<typeof useNotebookChat>;
    modelTiers: unknown;
    selectedTier: string;
    onTierChange: (tier: string) => void;
    readOnly: boolean;
    privateHint: boolean;
    sourceCount: number | null;
    onCitationClick: (source: unknown) => void;
}) {
    const Chat = NotebookChat as unknown as React.ComponentType<any>;
    return (
        <Chat
            messages={chat.messages}
            isLoading={chat.isLoading}
            locked={chat.locked}
            onSend={chat.send}
            onStop={chat.stop}
            onRetry={chat.retry}
            onEdit={chat.edit}
            modelTiers={modelTiers}
            selectedTier={selectedTier}
            onTierChange={onTierChange}
            // A viewer's chat can quote the notebook but not write into it.
            onInsertToDocument={readOnly ? null : chat.insertIntoDocument}
            onCitationClick={onCitationClick}
            // null until the sources are known: "0 sources" only when it IS none.
            sourceCount={sourceCount}
            privateHint={privateHint}
            onNewChat={() => { void chat.newChat(); }}
            clearingChat={chat.clearingChat}
        />
    );
}

export function NotebookOverlays({ citationSource, onCloseCitation, signOpen, onCloseSign, exportsApi, title, versions }: {
    citationSource: unknown;
    onCloseCitation: () => void;
    signOpen: boolean;
    onCloseSign: () => void;
    exportsApi: ReturnType<typeof useNotebookExports>;
    title: string;
    versions: React.ReactNode;
}) {
    const Citation = CitationOverlay as unknown as React.ComponentType<any>;
    const Sign = SendForSigningModal as unknown as React.ComponentType<any>;
    return (
        <>
            <Citation source={citationSource} onClose={onCloseCitation} />
            <Sign
                open={signOpen}
                onClose={onCloseSign}
                onSend={exportsApi.handleSendForSigning}
                sending={exportsApi.signSending}
                error={exportsApi.signError}
                onClearError={exportsApi.clearSignError}
                notebookTitle={title}
            />
            {versions}
        </>
    );
}
