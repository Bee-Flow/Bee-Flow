import { EyeOff, Menu, MoreVertical, Pencil, PenLine } from 'lucide-react';
import DocumentsHeaderButton from './DocumentsHeaderButton';
import EmptyChatState from './EmptyChatState';
import InputArea from '../components/chat/InputArea';
import MessageItem from '../components/chat/MessageItem';
import ProjectContextPill from '../components/chat/ProjectContextPill';
import SharedChatReadOnly, { isReadOnlySharedChat } from '../components/chat/SharedChatReadOnly';
import CoworkModeToggle from '../components/cowork/CoworkModeToggle';
import WelcomeScreen from '../components/shell/WelcomeScreen';
import { isImageAvatar, pickAgentAvatar, resolveAvatarSrc } from '../utils/agentAvatar';
import { lazy } from '../utils/lazyWithReload';
import { useTranslation } from '../hooks/useTranslation';

const WebpagePickerPopover = lazy(() => import('../components/webpages/WebpagePickerPopover'));

// The agent-chat pane: header (avatar, agent menu, Cowork switch, documents /
// webpage buttons) plus the chat pane and side panels. Moved verbatim from
// the `selectedAgent` branch of AgentHub.jsx's main ternary; all state stays
// in AgentHub and arrives via props.
const AgentChatView = ({
    isMobile, setSidebarOpen, selectedAgent, user, onNavigate, favorites,
    showAgentMenu, setShowAgentMenu,
    handleNewChat, handleToggleFavorite, handleUnpublishAgent,
    coworkMode, setCoworkModeForAgent, conversationStarted,
    notebooksEnabled, inCoworkMode,
    sidePanelDocumentId, openDocumentInSidePanel, closeDocumentPanel,
    canUseWebpagesSide, webpageButtonRef, sidePanelWebpageId, closeWebpagePanel,
    webpagePickerOpen, setWebpagePickerOpen, openWebpageInSidePanel,
    messagesContainerRef, messagesEndRef, shouldForceScrollRef,
    messages, chatInput, setChatInput, sendMessage, stopGenerating, isLoading,
    activeSkillIds, agentAttachedSkillIds, handleToggleSkill,
    handleVoiceTurnComplete, coworkComposer,
    currentConversation, retryMessage, editAndRegenerate, modelTiers,
    renderSidePanels,
    activeProject = null, onOpenActiveProject, onLeaveActiveProject,
    // useChatSignals() from useAgentHubData: the chat-signals notice for the
    // endpoint this chat posts to, and the person's own switch. Both composers
    // below get it, so the empty state and the conversation say the same.
    chatSignals = null,
}) => {
    const { t } = useTranslation();
    // The empty state and the conversation render the same composer.
    const composerProps = {
        onSendMessage: (text, attachments, parentId) => {
            shouldForceScrollRef.current = true;
            sendMessage(text, attachments, parentId, false);
        },
        onStopGenerating: stopGenerating,
        isLoading,
        selectedAgent,
        agentIntegrations: selectedAgent?.config?.enabledIntegrations || null,
        isMobile,
        input: chatInput,
        setInput: setChatInput,
        user,
        activeSkillIds,
        agentAttachedSkillIds,
        onToggleSkill: handleToggleSkill,
        messages,
        onVoiceTurnComplete: handleVoiceTurnComplete,
        chatSignalsNotice: chatSignals?.notice ?? null,
        onChatSignalsCounted: chatSignals?.setCounted ?? null,
        cowork: coworkComposer,
        coworkMode,
        onCoworkModeChange: (mode) => setCoworkModeForAgent(mode, selectedAgent?.id),
    };
    return (
                    <>
                        {/* New Inline Header for Agent */}
                        <div className={`relative h-14 flex items-center justify-between ${isMobile ? 'px-3' : 'px-6'} bg-[var(--bg-primary)]/80 backdrop-blur-md sticky top-0 z-20 border-b border-[var(--border-subtle)]/50`}>
                            <div className="flex items-center gap-2">
                                {isMobile && (
                                    <button
                                        onClick={() => setSidebarOpen(true)}
                                        className="p-1.5 rounded-lg hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors"
                                    >
                                        <Menu className="w-5 h-5" />
                                    </button>
                                )}
                                <div className="w-8 h-8 rounded-lg flex items-center justify-center text-sm overflow-hidden">
                                    {(() => {
                                        const av = pickAgentAvatar(selectedAgent);
                                        return isImageAvatar(av) ? (
                                            <img src={resolveAvatarSrc(av)} alt="" className="w-full h-full object-cover" />
                                        ) : (
                                            <span className="font-bold text-[var(--text-primary)]">
                                                {av || selectedAgent.name?.[0]?.toUpperCase()}
                                            </span>
                                        );
                                    })()}
                                </div>
                                <h1 className="font-semibold text-[var(--text-primary)] text-sm">{selectedAgent.name}</h1>
                                <div className="relative">
                                    <button
                                        onClick={() => setShowAgentMenu(v => !v)}
                                        className="p-1 rounded-md hover:bg-[var(--bg-tertiary)] transition-colors text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                                    >
                                        <MoreVertical className="w-4 h-4" />
                                    </button>
                                    {showAgentMenu && (
                                        <>
                                            <div className="fixed inset-0 z-40" onClick={() => setShowAgentMenu(false)} />
                                            <div
                                                className="absolute top-full left-0 mt-1 w-44 rounded-lg border shadow-xl overflow-hidden z-50"
                                                style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-subtle)' }}
                                            >
                                                <button
                                                    onClick={() => { setShowAgentMenu(false); handleNewChat(); }}
                                                    className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-[var(--bg-secondary)] transition-colors text-left"
                                                    style={{ color: 'var(--text-primary)' }}
                                                >
                                                    <PenLine className="w-4 h-4" />
                                                    {t('sidebar.new_chat', 'New Chat')}
                                                </button>
                                                <button
                                                    onClick={() => { handleToggleFavorite(selectedAgent.id); setShowAgentMenu(false); }}
                                                    className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-[var(--bg-secondary)] transition-colors text-left"
                                                    style={{ color: 'var(--text-primary)' }}
                                                >
                                                    {favorites.includes(selectedAgent.id) ? 'Remove from favorites' : 'Add to favorites'}
                                                </button>
                                                {(selectedAgent.owner_id === user?.id || user?.isAdmin || (user?.permissions || []).includes('all')) && (
                                                    <>
                                                        {!isMobile && (
                                                        <button
                                                            onClick={() => { setShowAgentMenu(false); onNavigate(`agentDesigner:${selectedAgent.id}`); }}
                                                            className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-[var(--bg-secondary)] transition-colors text-left"
                                                            style={{ color: 'var(--text-primary)' }}
                                                        >
                                                            <Pencil className="w-4 h-4" />
                                                            {t('agent.edit_agent', 'Edit Agent')}
                                                        </button>
                                                        )}
                                                        <button
                                                            onClick={() => { handleUnpublishAgent(selectedAgent.id); setShowAgentMenu(false); }}
                                                            className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-[var(--bg-secondary)] transition-colors text-left"
                                                            style={{ color: 'var(--error, #ef4444)' }}
                                                        >
                                                            <EyeOff className="w-4 h-4" />
                                                            {t('agent.chat_menu_unpublish_agent', 'Unpublish Agent')}
                                                        </button>
                                                    </>
                                                )}
                                            </div>
                                        </>
                                    )}
                                </div>
                                {activeProject && (
                                    <ProjectContextPill
                                        project={activeProject}
                                        compact={isMobile}
                                        onOpen={() => onOpenActiveProject?.(activeProject)}
                                        onLeave={() => onLeaveActiveProject?.()}
                                    />
                                )}
                            </div>
                            {/* Centred on the pane, not tucked in with Notebook and
                                Webpage: those open a panel beside the conversation,
                                while this decides what the composer below it even
                                does. Absolutely positioned so it stays on the
                                header's centre line however wide the two groups
                                either side of it grow. */}
                            <div className="absolute left-1/2 -translate-x-1/2 flex items-center">
                                <CoworkModeToggle
                                    enabled
                                    value={coworkMode}
                                    onChange={(mode) => setCoworkModeForAgent(mode, selectedAgent?.id)}
                                    locked={conversationStarted}
                                />
                            </div>
                            <div className="flex items-center gap-2 relative">
                                {!isMobile && !inCoworkMode && (
                                    <DocumentsHeaderButton
                                        sidePanelDocumentId={sidePanelDocumentId}
                                        openDocumentInSidePanel={openDocumentInSidePanel}
                                        closeDocumentPanel={closeDocumentPanel}
                                    />
                                )}
                                {!isMobile && canUseWebpagesSide && !inCoworkMode && (
                                    <>
                                        <button
                                            ref={webpageButtonRef}
                                            onClick={() => {
                                                if (sidePanelWebpageId) closeWebpagePanel();
                                                else setWebpagePickerOpen(v => !v);
                                            }}
                                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-colors border text-xs font-medium ${sidePanelWebpageId ? 'bg-[var(--accent-primary)]/10 text-[var(--accent-primary)] border-[var(--accent-primary)]/30' : 'bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border-[var(--border-subtle)]'}`}
                                            title={sidePanelWebpageId ? 'Close Webpage' : 'Open Webpage'}
                                        >
                                            🌐 {sidePanelWebpageId ? 'Close' : 'Webpage'}
                                        </button>
                                        <WebpagePickerPopover
                                            anchorRef={webpageButtonRef}
                                            open={webpagePickerOpen && !sidePanelWebpageId}
                                            onClose={() => setWebpagePickerOpen(false)}
                                            onSelect={openWebpageInSidePanel}
                                        />
                                    </>
                                )}
                            </div>
                        </div>

                        {/* Split Panes if Workspace Enabled */}
                        <div className="flex-1 flex overflow-hidden">
                            {/* Chat Pane */}
                            <div className="flex-1 flex flex-col min-w-0 border-r" style={{ borderColor: 'var(--border-subtle)' }}>
                                <div ref={messagesContainerRef} className={`flex-1 overflow-y-auto ${isMobile ? 'p-2' : 'p-4'} custom-scrollbar`}>
                                    {messages.length === 0 ? (
                                        <EmptyChatState>
                                            <WelcomeScreen
                                                agent={selectedAgent}
                                                onSendMessage={(text) => { setChatInput(text); }}
                                                user={user}
                                                shieldApplies
                                                onNavigate={onNavigate}
                                            >
                                                <InputArea {...composerProps} />
                                            </WelcomeScreen>
                                        </EmptyChatState>
                                    ) : (
                                        <div className="max-w-full px-6 mx-auto space-y-6 pb-4">
                                            {messages.filter(m => !m.parentId).map((msg, idx) => (
                                                <MessageItem
                                                    key={msg.id || idx}
                                                    idx={idx}
                                                    msg={msg}
                                                    selectedAgent={selectedAgent}
                                                    onCopy={(txt) => navigator.clipboard.writeText(txt)}
                                                    allMessages={messages}
                                                    conversationId={currentConversation?.id}
                                                    agentId={selectedAgent?.id}
                                                    chatSource="agent"
                                                    onRetry={retryMessage}
                                                    onEditMessage={editAndRegenerate}
                                                    modelTiers={modelTiers}
                                                />
                                            ))}
                                            <div ref={messagesEndRef} />
                                        </div>
                                    )}
                                </div>


                                {/* A viewer reading a colleague's shared thread cannot post into it. */}
                                {messages.length > 0 && isReadOnlySharedChat(currentConversation) && <SharedChatReadOnly />}
                                {messages.length > 0 && !isReadOnlySharedChat(currentConversation) && (
                                    <div className="w-full flex flex-col shrink-0">
                                        <InputArea {...composerProps} />
                                    </div>
                                )}
                            </div>

                            {renderSidePanels('agent')}
                        </div>
                    </>
    );
};

export default AgentChatView;
