import { lazy } from '../utils/lazyWithReload';
import { logger } from '../utils/logger';

const WorkspaceNotebook = lazy(() => import('../components/chat/WorkspaceNotebook'));
const GammaPreviewPanel = lazy(() => import('../components/chat/GammaPreviewPanel'));
const SideWebpagePanel = lazy(() => import('../components/webpages/SideWebpagePanel'));
const SideDocumentPanel = lazy(() => import('../components/documents/SideDocumentPanel'));

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
}) => {
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
                            onSelectionChange={(text) => { setNotebookSelection(text); }}
                            onAskAI={(message) => {
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
                            onFilesLoaded={(files) => {
                                if (files) setSidePanelWebpageFiles({
                                    html: files.html || '',
                                    css: files.css || '',
                                    js: files.js || '',
                                });
                            }}
                            onSelectionAttach={(sel) => { if (sel?.text) setAttachedWebpageSelection(sel); }}
                            reloadKey={sidePanelReloadKey}
                            onNavigate={onNavigate}
                        />
                    </div>
                )}
            </>
        );
};

export default ChatSidePanels;
