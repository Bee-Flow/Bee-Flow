import React from 'react';
import beeFlowIcon from '../assets/BeeFlow-logo-Icon-2026.svg';
import AgentChatView from './AgentChatView';
import DirectChatView from './DirectChatView';
import type { AgentLike } from './useAgentHubData';

type Translate = (key: string, fallback?: string) => string;

/**
 * The bottom of the hub's main-content ternary: the agent chat when an agent
 * is selected, else the direct chat, else the welcome state. Everything here
 * is handed straight through from AgentHub, which owns the state.
 */
interface HubChatContentBase {
    directChatMode: boolean;
    t: Translate;
    /** Mirrors AgentHub's setter; the pill's "leave" clears the chat context. */
    setActiveProject: (project: null) => void;
    // The rest is plumbing for AgentChatView / DirectChatView, untyped there.
    [prop: string]: any;
}

/** With an agent selected the agent chat shows; without one, the direct chat or the welcome state. */
export type HubChatContentProps = HubChatContentBase & ({ selectedAgent: AgentLike } | { selectedAgent: null });
type AgentChatProps = HubChatContentBase & { selectedAgent: AgentLike };

// Plain render functions rather than components: the element tree stays the one
// AgentHub rendered inline (AgentChatView / DirectChatView / the welcome div
// directly in the main column), so nothing remounts that did not before.
function agentChat(p: AgentChatProps) {
    const {
        activeProjectLive, activeSkillIds, agentAttachedSkillIds, canUseWebpagesSide, chatInput, chatSignals,
        closeDocumentPanel, closeWebpagePanel, conversationStarted, coworkComposer, coworkMode,
        currentConversation, editAndRegenerate, favorites, handleNewChat, handleToggleFavorite,
        handleToggleSkill, handleUnpublishAgent, handleVoiceTurnComplete, inCoworkMode, isLoading, isMobile,
        messages, messagesContainerRef, messagesEndRef, modelTiers, notebooksEnabled, onNavigate,
        openActiveProject, openDocumentInSidePanel, openWebpageInSidePanel, renderSidePanels, retryMessage,
        selectedAgent, sendMessage, setActiveProject, setChatInput, setCoworkModeForAgent, setShowAgentMenu,
        setSidebarOpen, setWebpagePickerOpen, shouldForceScrollRef, showAgentMenu, sidePanelDocumentId,
        sidePanelWebpageId, stopGenerating, user, webpageButtonRef, webpagePickerOpen,
    } = p;
    return (
        <AgentChatView
            isMobile={isMobile}
            setSidebarOpen={setSidebarOpen}
            selectedAgent={selectedAgent}
            user={user}
            onNavigate={onNavigate}
            favorites={favorites}
            showAgentMenu={showAgentMenu}
            setShowAgentMenu={setShowAgentMenu}
            handleNewChat={handleNewChat}
            handleToggleFavorite={handleToggleFavorite}
            handleUnpublishAgent={handleUnpublishAgent}
            coworkMode={coworkMode}
            setCoworkModeForAgent={setCoworkModeForAgent}
            conversationStarted={conversationStarted}
            notebooksEnabled={notebooksEnabled}
            inCoworkMode={inCoworkMode}
            sidePanelDocumentId={sidePanelDocumentId}
            openDocumentInSidePanel={openDocumentInSidePanel}
            closeDocumentPanel={closeDocumentPanel}
            canUseWebpagesSide={canUseWebpagesSide}
            webpageButtonRef={webpageButtonRef}
            sidePanelWebpageId={sidePanelWebpageId}
            closeWebpagePanel={closeWebpagePanel}
            webpagePickerOpen={webpagePickerOpen}
            setWebpagePickerOpen={setWebpagePickerOpen}
            openWebpageInSidePanel={openWebpageInSidePanel}
            messagesContainerRef={messagesContainerRef}
            messagesEndRef={messagesEndRef}
            shouldForceScrollRef={shouldForceScrollRef}
            messages={messages}
            chatInput={chatInput}
            setChatInput={setChatInput}
            sendMessage={sendMessage}
            stopGenerating={stopGenerating}
            isLoading={isLoading}
            activeSkillIds={activeSkillIds}
            agentAttachedSkillIds={agentAttachedSkillIds}
            handleToggleSkill={handleToggleSkill}
            handleVoiceTurnComplete={handleVoiceTurnComplete}
            coworkComposer={coworkComposer}
            currentConversation={currentConversation}
            retryMessage={retryMessage}
            editAndRegenerate={editAndRegenerate}
            modelTiers={modelTiers}
            renderSidePanels={renderSidePanels}
            activeProject={activeProjectLive}
            onOpenActiveProject={openActiveProject}
            onLeaveActiveProject={() => setActiveProject(null)}
            chatSignals={chatSignals}
        />
    );
}

function directChat(p: HubChatContentProps) {
    const {
        activeProjectLive, activeSkillIds, attachedWebpageSelection, canUseWebpagesSide, chatInput,
        chatSignals, clearWebpageSelection, closeDocumentPanel, closeWebpagePanel, conversationStarted,
        coworkComposer, coworkMode, currentDirectConversation, directActivatedSessionSkillIds,
        directChatKBIds, directChatKbs, directCompletedSessionSkillIds, directSessionSkills,
        editAndRegenerate, handleToggleSkill, handleVoiceTurnComplete, inCoworkMode, isLoading, isMobile,
        messages, messagesContainerRef, messagesEndRef, modelTiers, notebooksEnabled, openActiveProject,
        openDocumentInSidePanel, openWebpageInSidePanel, renderSidePanels, retryMessage, selectedTier,
        sendMessage, setActiveProject, setAttachedWebpageSelection, setChatInput, setCoworkMode,
        setDirectChatKBIds, setSelectedTier, setSidebarOpen, setWebpagePickerOpen, shouldForceScrollRef,
        sidePanelDocumentId, sidePanelWebpageId, stopGenerating, user, webpageButtonRefDirect,
        webpagePickerOpen,
    } = p;
    return (
        /* Direct Chat Mode */
        <DirectChatView
            isMobile={isMobile}
            setSidebarOpen={setSidebarOpen}
            user={user}
            notebooksEnabled={notebooksEnabled}
            conversationStarted={conversationStarted}
            coworkMode={coworkMode}
            setCoworkMode={setCoworkMode}
            inCoworkMode={inCoworkMode}
            sidePanelDocumentId={sidePanelDocumentId}
            openDocumentInSidePanel={openDocumentInSidePanel}
            closeDocumentPanel={closeDocumentPanel}
            canUseWebpagesSide={canUseWebpagesSide}
            webpageButtonRefDirect={webpageButtonRefDirect}
            sidePanelWebpageId={sidePanelWebpageId}
            closeWebpagePanel={closeWebpagePanel}
            webpagePickerOpen={webpagePickerOpen}
            setWebpagePickerOpen={setWebpagePickerOpen}
            openWebpageInSidePanel={openWebpageInSidePanel}
            messagesContainerRef={messagesContainerRef}
            messagesEndRef={messagesEndRef}
            shouldForceScrollRef={shouldForceScrollRef}
            messages={messages}
            chatInput={chatInput}
            setChatInput={setChatInput}
            sendMessage={sendMessage}
            stopGenerating={stopGenerating}
            isLoading={isLoading}
            modelTiers={modelTiers}
            selectedTier={selectedTier}
            setSelectedTier={setSelectedTier}
            activeSkillIds={activeSkillIds}
            handleToggleSkill={handleToggleSkill}
            handleVoiceTurnComplete={handleVoiceTurnComplete}
            coworkComposer={coworkComposer}
            directSessionSkills={directSessionSkills}
            directActivatedSessionSkillIds={directActivatedSessionSkillIds}
            directCompletedSessionSkillIds={directCompletedSessionSkillIds}
            currentDirectConversation={currentDirectConversation}
            directChatKbs={directChatKbs}
            directChatKBIds={directChatKBIds}
            setDirectChatKBIds={setDirectChatKBIds}
            attachedWebpageSelection={attachedWebpageSelection}
            clearWebpageSelection={clearWebpageSelection}
            setAttachedWebpageSelection={setAttachedWebpageSelection}
            retryMessage={retryMessage}
            editAndRegenerate={editAndRegenerate}
            renderSidePanels={renderSidePanels}
            activeProject={activeProjectLive}
            onOpenActiveProject={openActiveProject}
            onLeaveActiveProject={() => setActiveProject(null)}
            chatSignals={chatSignals}
        />
    );
}

function welcome({ t, onCloseSettings, onCloseAgentDesigner, setShowMarketplace }: HubChatContentProps) {
    return (
        /* No Agent Selected - Empty State */
        <div className="flex-1 flex flex-col items-center justify-center p-8">
            <img src={beeFlowIcon} alt={t('app.agent_hub_logo_alt', 'Bee Flow')} className="w-24 h-24 rounded-2xl object-contain mb-6 shadow-xl" />
            <h1 className="text-2xl font-bold text-[var(--text-primary)] mb-2">
                {t('app.agent_hub_welcome_title', 'Welcome to Bee Flow')}
            </h1>
            <p className="text-[var(--text-secondary)] text-center max-w-md mb-8">
                {t('app.agent_hub_welcome_body', 'Select an agent from the marketplace to start chatting, or create your own custom AI assistant.')}
            </p>
            <button
                onClick={() => { if (onCloseSettings) onCloseSettings(); if (onCloseAgentDesigner) onCloseAgentDesigner(); setShowMarketplace(true); }}
                className="flex items-center gap-2 px-6 py-3 bg-[var(--accent-primary)] hover:bg-[var(--accent-primary-hover)] text-white rounded-xl font-medium shadow-lg transition-all hover:scale-105"
            >
                {t('app.agent_hub_browse_agents', 'Browse Agents')}
            </button>
        </div>
    );
}

/** The chat slot's element, called (not mounted) by HubMainContent. */
export function renderHubChat(props: HubChatContentProps) {
    return props.selectedAgent ? agentChat(props) : props.directChatMode ? directChat(props) : welcome(props);
}
