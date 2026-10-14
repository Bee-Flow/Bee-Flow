import { lazy } from '../utils/lazyWithReload';
import { logger } from '../utils/logger';
import type { GammaPreview } from '../hooks/useChatEngine/sse/gammaPreview';
import type { SidePanelWebpage, SidePanelWebpageFiles, WebpageSelection } from './useSidePanelState';

const WorkspaceNotebook = lazy(() => import('../components/chat/WorkspaceNotebook'));
const GammaPreviewPanel = lazy(() => import('../components/chat/GammaPreviewPanel'));
const SideWebpagePanel = lazy(() => import('../components/webpages/SideWebpagePanel'));
const SideDocumentPanel = lazy(() => import('../components/documents/SideDocumentPanel'));

/** A conversation as the panels read it: only the id matters here. */
interface PanelConversation {
    id?: string;
}

export interface ChatSidePanelsProps {
    mode: string;
    isMobile: boolean;
    notebooksEnabled: boolean;
    notebookWrapperClass: string;
    showNotebook: boolean;
    setShowNotebook: (show: boolean) => void;
    showGammaPreview: boolean;
    setShowGammaPreview: (show: boolean) => void;
    notebookContent: string;
    setNotebookContent: (content: string) => void;
    setNotebookSelection: (selection: string) => void;
    saveNotebook: () => unknown;
    handleOpenInNotebook: () => void;
    isLoading: boolean;
    selectedAgent: PanelConversation | null;
    sendMessage: (message: string, attachments: unknown[]) => void;
    user: Record<string, unknown> | null;
    currentConversation: PanelConversation | null;
    currentDirectConversation: PanelConversation | null;
    notebookLinkedId: string | null;
    setNotebookLinkedId: (id: string | null) => void;
    gammaPreview: GammaPreview | null;
    setGammaPreview: (preview: GammaPreview | null) => void;
    sidePanelWebpageId: string | null;
    closeWebpagePanel: () => void;
    setSidePanelWebpage: (webpage: SidePanelWebpage | null) => void;
    setSidePanelWebpageFiles: (files: SidePanelWebpageFiles) => void;
    setAttachedWebpageSelection: (selection: WebpageSelection | null) => void;
    sidePanelReloadKey: number;
    onNavigate: (...args: never[]) => void;
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
                            onFilesLoaded={(files: Partial<SidePanelWebpageFiles> | null) => {
                                if (files) setSidePanelWebpageFiles({
                                    html: files.html || '',
                                    css: files.css || '',
                                    js: files.js || '',
                                });
                            }}
                            onSelectionAttach={(sel: WebpageSelection | null) => { if (sel?.text) setAttachedWebpageSelection(sel); }}
                            reloadKey={sidePanelReloadKey}
                            onNavigate={onNavigate}
                        />
                    </div>
                )}
            </>
        );
};

export default ChatSidePanels;
