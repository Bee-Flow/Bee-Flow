import type { Dispatch, SetStateAction } from 'react';
import { lazy } from '../utils/lazyWithReload';
import { logger } from '../utils/logger';
import type { HubUser } from './useAgentHubData';
import type { GammaPreview } from '../hooks/useChatEngine/sse/gammaPreview';
import type { PreviewSelection } from '../pages/webpages/preview/usePreviewToken';
import type { WebpageRow } from '../api/webpageEditorTypes';

const WorkspaceNotebook = lazy(() => import('../components/chat/WorkspaceNotebook'));
const GammaPreviewPanel = lazy(() => import('../components/chat/GammaPreviewPanel'));
const SideWebpagePanel = lazy(() => import('../components/webpages/SideWebpagePanel'));
const SideDocumentPanel = lazy(() => import('../components/documents/SideDocumentPanel'));

interface IdRef { id?: string | null }

interface ChatSidePanelsProps {
    mode: 'agent' | 'direct';
    isMobile: boolean;
    notebooksEnabled: boolean;
    notebookWrapperClass: string;
    showNotebook: boolean;
    setShowNotebook: (show: boolean) => void;
    showGammaPreview: boolean;
    setShowGammaPreview: (show: boolean) => void;
    notebookContent: string;
    setNotebookContent: (content: string) => void;
    setNotebookSelection: (text: string) => void;
    saveNotebook: (content: SetStateAction<string>, notebookId?: string | null) => unknown;
    handleOpenInNotebook: (markdownContent: string, existingNotebookId?: string | null) => unknown;
    isLoading: boolean;
    selectedAgent: IdRef | null;
    sendMessage: (message: string, attachments: never[]) => void;
    user: HubUser | null;
    currentConversation: IdRef | null;
    currentDirectConversation: IdRef | null;
    notebookLinkedId: string | null;
    setNotebookLinkedId: (id: string | null) => void;
    gammaPreview: GammaPreview & { error?: string } | null;
    setGammaPreview: (preview: GammaPreview & { error?: string }) => void;
    sidePanelWebpageId: string | null;
    closeWebpagePanel: () => void;
    setSidePanelWebpage: (webpage: WebpageRow | null) => void;
    setSidePanelWebpageFiles: Dispatch<SetStateAction<{ html: string; css: string; js: string }>>;
    setAttachedWebpageSelection: (selection: PreviewSelection) => void;
    sidePanelReloadKey: number;
    onNavigate: (page: string) => void;
    sidePanelDocumentId: string | null;
    closeDocumentPanel: () => void;
}

// Right-hand split column shared by the agent-chat and direct-chat layouts.
// The notebook / gamma-preview / webpage / document panels are mutually exclusive and
// render identically in both modes apart from which conversation id the
// notebook binds to (and the onAskAI debug log's mode tag). Moved verbatim
// from AgentHub.jsx's renderSidePanels.
const ChatSidePanels = ({
    mode, isMobile, notebooksEnabled, notebookWrapperClass,
    showNotebook, setShowNotebook, showGammaPreview, setShowGammaPreview,
    notebookContent, setNotebookContent, setNotebookSelection,
    saveNotebook, handleOpenInNotebook,
    isLoading, selectedAgent, sendMessage, user,
    currentConversation, currentDirectConversation,
    notebookLinkedId, setNotebookLinkedId,
    gammaPreview, setGammaPreview,
    sidePanelWebpageId, closeWebpagePanel, setSidePanelWebpage,
    setSidePanelWebpageFiles, setAttachedWebpageSelection,
    sidePanelReloadKey, onNavigate,
    sidePanelDocumentId, closeDocumentPanel,
}: ChatSidePanelsProps) => {
        const conversationId = mode === 'agent'
            ? currentConversation?.id
            : currentDirectConversation?.id;
        return (
            <>
                {/* Notebook Pane — sibling split column at all viewport sizes
                    (mobile uses a separate full-screen layout, not handled here). */}
                {!isMobile && notebooksEnabled && showNotebook && !showGammaPreview && (
                    <div className={notebookWrapperClass}>
                        <WorkspaceNotebook
                            content={notebookContent}
                            onChange={setNotebookContent}
                            onSave={saveNotebook}
                            onClose={() => setShowNotebook(false)}
                            onSelectionChange={(text: string) => { setNotebookSelection(text); }}
                            onAskAI={(message: string) => {
                                if (mode === 'agent') {
                                    logger.debug('[Notebook AI] AgentHub.onAskAI -> sendMessage, isLoading=', isLoading, 'mode=agent', 'agent=', selectedAgent?.id);
                                } else {
                                    logger.debug('[Notebook AI] AgentHub.onAskAI -> sendMessage, isLoading=', isLoading, 'mode=direct');
                                }
                                sendMessage(message, []);
                            }}
                            onOpenInNotebook={notebooksEnabled ? handleOpenInNotebook : undefined}
                            user={user}
                            conversationId={conversationId}
                            existingNotebookId={notebookLinkedId}
                            onNotebookIdChange={setNotebookLinkedId}
                        />
                    </div>
                )}
                {!isMobile && showGammaPreview && (
                    <div className={notebookWrapperClass}>
                        <GammaPreviewPanel
                            preview={gammaPreview}
                            onClose={() => setShowGammaPreview(false)}
                            onUpdate={setGammaPreview}
                        />
                    </div>
                )}
                {!isMobile && sidePanelDocumentId && !showNotebook && !showGammaPreview && !sidePanelWebpageId && (
                    <div className={notebookWrapperClass}>
                        <SideDocumentPanel
                            documentId={sidePanelDocumentId}
                            onClose={closeDocumentPanel}
                            onNavigate={onNavigate}
                        />
                    </div>
                )}
                {!isMobile && sidePanelWebpageId && !showNotebook && !showGammaPreview && (
                    <div className={notebookWrapperClass}>
                        <SideWebpagePanel
                            webpageId={sidePanelWebpageId}
                            onClose={closeWebpagePanel}
                            user={user}
                            onLoaded={setSidePanelWebpage}
                            onFilesLoaded={(files: { html?: string; css?: string; js?: string } | null) => {
                                if (files) setSidePanelWebpageFiles({
                                    html: files.html || '',
                                    css: files.css || '',
                                    js: files.js || '',
                                });
                            }}
                            onSelectionAttach={(sel: PreviewSelection) => { if (sel?.text) setAttachedWebpageSelection(sel); }}
                            reloadKey={sidePanelReloadKey}
                            onNavigate={onNavigate}
                        />
                    </div>
                )}
            </>
        );
};

export default ChatSidePanels;
