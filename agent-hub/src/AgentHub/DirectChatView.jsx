import { Menu, X } from 'lucide-react';
import React from 'react';
import EmptyChatState from './EmptyChatState';
import DirectChatWelcome from '../components/chat/DirectChatWelcome';
import InputArea from '../components/chat/InputArea';
import MessageItem from '../components/chat/MessageItem';
import ProjectContextPill from '../components/chat/ProjectContextPill';
import SharedChatReadOnly, { isReadOnlySharedChat } from '../components/chat/SharedChatReadOnly';
import CoworkModeToggle from '../components/cowork/CoworkModeToggle';
import CoworkWelcome from '../components/cowork/CoworkWelcome';
import { lazy } from '../utils/lazyWithReload';

const WebpagePickerPopover = lazy(() => import('../components/webpages/WebpagePickerPopover'));

// The direct-chat pane: minimal toolbar (Cowork switch, notebook / webpage
// buttons), the mode-dependent welcome state, the chat pane, the webpage
// selection chip and the side panels. Moved verbatim from the
// `directChatMode` branch of AgentHub.jsx's main ternary; all state stays in
// AgentHub and arrives via props.
const DirectChatView = ({
    isMobile, setSidebarOpen, user,
    notebooksEnabled, conversationStarted,
    coworkMode, setCoworkMode, inCoworkMode,
    toggleNotebookPanel, showNotebook,
    canUseWebpagesSide, webpageButtonRefDirect, sidePanelWebpageId, closeWebpagePanel,
    webpagePickerOpen, setWebpagePickerOpen, openWebpageInSidePanel,
    messagesContainerRef, messagesEndRef, shouldForceScrollRef,
    messages, chatInput, setChatInput, sendMessage, stopGenerating, isLoading,
    modelTiers, selectedTier, setSelectedTier,
    activeSkillIds, handleToggleSkill, handleVoiceTurnComplete, coworkComposer,
    directSessionSkills, directActivatedSessionSkillIds, directCompletedSessionSkillIds,
    currentDirectConversation, directChatKbs, directChatKBIds, setDirectChatKBIds,
    attachedWebpageSelection, clearWebpageSelection, setAttachedWebpageSelection,
    retryMessage, editAndRegenerate,
    renderSidePanels,
    activeProject = null, onOpenActiveProject, onLeaveActiveProject,
    // useChatSignals() from useAgentHubData: the chat-signals notice for the
    // endpoint this chat posts to, and the person's own switch. Both composers
    // below get it, so the empty state and the conversation say the same.
    chatSignals = null,
}) => {
    // The empty state and the conversation render the same composer; only how
    // a send ends (the conversation also drops a picked webpage selection) and
    // the empty state's Shield note differ, so those two stay on the elements.
    const composerProps = {
        onStopGenerating: stopGenerating,
        isLoading,
        directMode: true,
        modelTiers,
        selectedTier,
        onTierChange: setSelectedTier,
        input: chatInput,
        isMobile,
        setInput: setChatInput,
        user,
        activeSkillIds,
        directSessionSkills,
        directActivatedSessionSkillIds,
        directConversationId: currentDirectConversation?.id,
        onToggleSkill: handleToggleSkill,
        messages,
        onVoiceTurnComplete: handleVoiceTurnComplete,
        chatSignalsNotice: chatSignals?.notice ?? null,
        onChatSignalsCounted: chatSignals?.setCounted ?? null,
        cowork: coworkComposer,
        coworkMode,
        onCoworkModeChange: setCoworkMode,
        availableKBs: directChatKbs,
        selectedKBIds: directChatKBIds,
        onChangeKBIds: setDirectChatKBIds,
    };
    return (
                    /* Direct Chat Mode */
                    <>
                        {/* Minimal toolbar for Direct Chat. It also has to appear
                            for the Chat ⇄ Cowork switch alone: the switch lives
                            in here now, and a workspace without Notebooks would
                            otherwise have no header to put it in. The same
                            goes for the project pill: a chat inside a project
                            always says so. */}
                        {(isMobile || notebooksEnabled || !conversationStarted || activeProject) && (
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
                                    {activeProject && (
                                        <ProjectContextPill
                                            project={activeProject}
                                            compact={isMobile}
                                            onOpen={() => onOpenActiveProject?.(activeProject)}
                                            onLeave={() => onLeaveActiveProject?.()}
                                        />
                                    )}
                                </div>
                                {/* Centred — see the agent header above. */}
                                <div className="absolute left-1/2 -translate-x-1/2 flex items-center">
                                    <CoworkModeToggle
                                        enabled
                                        value={coworkMode}
                                        onChange={setCoworkMode}
                                        locked={conversationStarted}
                                    />
                                </div>
                                <div className="flex items-center gap-2 relative">
                                    {!isMobile && notebooksEnabled && !inCoworkMode && (
                                        <button
                                            onClick={toggleNotebookPanel}
                                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-colors border text-xs font-medium ${showNotebook ? 'bg-[var(--accent-primary)]/10 text-[var(--accent-primary)] border-[var(--accent-primary)]/30' : 'bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border-[var(--border-subtle)]'}`}
                                            title={showNotebook ? 'Close Notebook' : 'Open Notebook'}
                                        >
                                            📓 {showNotebook ? 'Close' : 'Notebook'}
                                        </button>
                                    )}
                                    {!isMobile && canUseWebpagesSide && !inCoworkMode && (
                                        <>
                                            <button
                                                ref={webpageButtonRefDirect}
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
                                                anchorRef={webpageButtonRefDirect}
                                                open={webpagePickerOpen && !sidePanelWebpageId}
                                                onClose={() => setWebpagePickerOpen(false)}
                                                onSelect={openWebpageInSidePanel}
                                            />
                                        </>
                                    )}
                                </div>
                            </div>
                        )}

                        {/* Split Panes: Chat + Workspace */}
                        <div className="flex-1 flex overflow-hidden">
                            {/* Chat Pane */}
                            <div className="flex-1 flex flex-col min-w-0 border-r" style={{ borderColor: 'var(--border-subtle)' }}>
                                <div ref={messagesContainerRef} className={`flex-1 overflow-y-auto ${isMobile ? 'p-2' : 'p-4'} custom-scrollbar`}>
                                    {messages.length === 0 ? (
                                        <EmptyChatState>
                                            {/* In Cowork the next thing typed is not
                                                answered here — it goes off and runs.
                                                "How can I help you?" over a composer
                                                that schedules work promises the wrong
                                                thing, so the empty state follows the
                                                mode. */}
                                            {React.createElement(
                                                coworkMode === 'cowork' ? CoworkWelcome : DirectChatWelcome,
                                                coworkMode === 'cowork'
                                                    ? {
                                                        isMobile,
                                                        onStarterClick: (text) => setChatInput(text),
                                                    }
                                                    : {
                                                        tiers: modelTiers,
                                                        selectedTier,
                                                        onTierChange: setSelectedTier,
                                                        onPromptClick: (text) => setChatInput(text),
                                                    },
                                                <InputArea
                                                    {...composerProps}
                                                    onSendMessage={(text, attachments) => { shouldForceScrollRef.current = true; sendMessage(text, attachments); }}
                                                    shieldApplies
                                                />,
                                            )}
                                        </EmptyChatState>
                                    ) : (
                                        <div className="max-w-full px-6 mx-auto space-y-6 pb-4">
                                            {messages.filter(m => !m.parentId).map((msg, idx) => (
                                                <MessageItem
                                                    key={msg.id || idx}
                                                    idx={idx}
                                                    msg={msg}
                                                    selectedAgent={{ name: 'AI', avatar: '💬' }}
                                                    onCopy={(txt) => navigator.clipboard.writeText(txt)}
                                                    allMessages={messages}
                                                    conversationId={currentDirectConversation?.id}
                                                    sessionSkills={directSessionSkills}
                                                    liveActivatedSkillIds={directActivatedSessionSkillIds}
                                                    liveCompletedSkillIds={directCompletedSessionSkillIds}
                                                    chatSource="direct"
                                                    onRetry={retryMessage}
                                                    onEditMessage={editAndRegenerate}
                                                    modelTiers={modelTiers}
                                                />
                                            ))}
                                            <div ref={messagesEndRef} />
                                        </div>
                                    )}
                                </div>
                                {/* A viewer reading a colleague's shared chat cannot post into it. */}
                                {messages.length > 0 && isReadOnlySharedChat(currentDirectConversation) && <SharedChatReadOnly />}
                                {messages.length > 0 && !isReadOnlySharedChat(currentDirectConversation) && (
                                    <div className="w-full flex flex-col shrink-0">
                                        {attachedWebpageSelection && sidePanelWebpageId && (
                                            <div className="mx-4 mb-2 px-3 py-2 rounded-lg border flex items-start gap-2"
                                                 style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-secondary)' }}>
                                                <div className="text-[11px] mt-0.5" style={{ color: 'var(--accent-primary)' }}>↳</div>
                                                <div className="flex-1 min-w-0">
                                                    <div className="text-[11px] font-medium mb-0.5" style={{ color: 'var(--text-secondary)' }}>
                                                        Selection from page{attachedWebpageSelection.tagName ? ` · <${attachedWebpageSelection.tagName}>` : ''}
                                                    </div>
                                                    <div className="text-[12px] truncate" style={{ color: 'var(--text-primary)' }}>
                                                        {attachedWebpageSelection.text.length > 140 ? attachedWebpageSelection.text.slice(0, 140) + '…' : attachedWebpageSelection.text}
                                                    </div>
                                                </div>
                                                <button
                                                    onClick={clearWebpageSelection}
                                                    className="p-0.5 rounded hover:bg-[var(--bg-tertiary)]"
                                                    title="Remove selection"
                                                >
                                                    <X className="w-3.5 h-3.5" style={{ color: 'var(--text-tertiary)' }} />
                                                </button>
                                            </div>
                                        )}
                                        <InputArea
                                            onSendMessage={(text, attachments) => {
                                                shouldForceScrollRef.current = true;
                                                sendMessage(text, attachments);
                                                // Single-shot — the user implicitly cleared their pick
                                                // by sending; next message starts fresh.
                                                if (attachedWebpageSelection) setAttachedWebpageSelection(null);
                                            }}
                                            {...composerProps}
                                        />
                                    </div>
                                )}
                            </div>

                            {renderSidePanels('direct')}
                        </div>
                    </>
    );
};

export default DirectChatView;
