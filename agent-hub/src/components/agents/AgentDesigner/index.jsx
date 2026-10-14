import React from "react";

import AgentListSidebar from "./AgentListSidebar";
import { CAPABILITIES } from "./constants";
import { DesignerEmptyState, DesignerSectionNav, KnowledgeSection } from "./DesignerPanels";

// Extracted hooks
import useAgentApi from "./hooks/useAgentApi";
import useAgentChat from "./hooks/useAgentChat";
import useAgentState from "./hooks/useAgentState";
import useCapabilities from "./hooks/useCapabilities";
import useDesignerEffects from "./hooks/useDesignerEffects";
import PublishMenu from "./PublishMenu";
import { BehaviorSection } from "./sections/BehaviorSection";
import { IdentitySection } from "./sections/IdentitySection";
import { ToolsSection } from "./sections/ToolsSection";
import { useTranslation } from '../../../hooks/useTranslation';
import { API_BASE, authFetch } from "../../../utils/helpers";

/** An agent editor reads, but may not change, someone else's unpublished agent. */
function isReadonlyFor(selectedAgent, user, isCreating) {
  const isAgentEditor = user?.orgRole === 'agent_editor';
  const isOwner = selectedAgent?.owner_id === user?.id;
  return Boolean(selectedAgent && isAgentEditor && !isOwner && !selectedAgent?.is_published && !isCreating);
}

const AgentDesigner = ({
  onBack: _onBack,
  systemMode = false,
  securityMode = false,
  hasPermission = () => true,
  initialAgentId = null,
  user = null,
  onClose = null,
}) => {
  const { t } = useTranslation();
  // All state from hooks
  const state = useAgentState();
  const { selectedAgent, isCreating } = state;

  // API operations
  const api = useAgentApi(state, { systemMode, securityMode, initialAgentId });

  // Chat (its hooks keep running for the sections that read the state it fills)
  useAgentChat(state);

  // Capabilities
  const { checkCapability, toggleCapability } = useCapabilities(state);

  useDesignerEffects(state);

  const isReadonly = isReadonlyFor(selectedAgent, user, isCreating);

  const sharedProps = {
    ...state,
    authFetch,
    API_BASE,
    CAPABILITIES,
    checkCapability,
    toggleCapability,
    isReadonly,
  };
  return (
    <div className="h-full flex flex-col bg-[var(--bg-primary)]">
      {/* Title bar — only rendered when inline (onClose provided) */}
      {onClose && (
        <div
          className="flex-shrink-0 flex items-center px-5"
          style={{ height: '48px', background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-subtle)' }}
        >
          <span className="text-[15px] font-semibold text-[var(--text-primary)]">{t('agent_studio.agent_designer_agent_designer', 'Agent Designer')}</span>
        </div>
      )}
      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden bg-[var(--bg-primary)]">
        {/* 1. Agent List Sidebar */}
        <AgentListSidebar
          agents={state.agents}
          selectedAgentId={selectedAgent?.id}
          loading={state.loading}
          systemMode={systemMode}
          canManage={hasPermission("manage_agents")}
          user={user}
          onSelect={api.selectAgent}
          onCreate={api.createNewAgent}
          onDuplicate={api.duplicateAgent}
          onDelete={api.deleteAgent}
        />

        {/* 2. Main Workspace (Split View) */}
        <div className="flex-1 flex overflow-hidden relative">
          {selectedAgent || isCreating ? (
            <AgentWorkspace state={state} api={api} systemMode={systemMode} isReadonly={isReadonly} sharedProps={sharedProps} />
          ) : (
            <DesignerEmptyState systemMode={systemMode} onCreate={api.createNewAgent} />
          )}
        </div>
      </div>
      {api.confirmDialog}
    </div>
  );
};

/** The open agent: its header (publish, save) and the section it is on. */
function AgentWorkspace({ state, api, systemMode, isReadonly, sharedProps }) {
  const { t } = useTranslation();
  const { selectedAgent, isCreating, activeSection } = state;
  return (
    <div className="flex-1 flex w-full">
      {/* Configuration Area */}
      <div className="flex-1 flex flex-col min-w-[600px] border-r border-[var(--border-default)]">
        {/* Header */}
        <div className="px-6 py-3 border-b flex items-center justify-between border-[var(--border-default)]">
          <div>
            <h1 className="text-lg font-semibold text-[var(--text-primary)]">
              {isCreating ? "Create New Agent" : "Edit Agent"}
            </h1>
            <p className="text-xs text-muted">
              {t('agent_studio.agent_designer_configure_identity_logic_and', 'Configure identity, logic, and safeguards.')}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {!systemMode && selectedAgent && (
              <PublishMenu
                isReadonly={isReadonly}
                isPublished={state.isPublished}
                sharedGroups={state.sharedGroups}
                setSharedGroups={state.setSharedGroups}
                orgGroups={state.orgGroups}
                showPublishMenu={state.showPublishMenu}
                setShowPublishMenu={state.setShowPublishMenu}
                publishError={state.publishError}
                setPublishError={state.setPublishError}
                setPublishState={api.setPublishState}
                togglePublish={api.togglePublish}
              />
            )}
            <div className="flex items-center gap-2">
              {isReadonly && (
                <span className="text-xs px-2 py-1 rounded bg-red-500/10 text-red-500 font-medium">{t('agent_studio.agent_designer_read_only_unpublished', 'Read-only (Unpublished)')}</span>
              )}
              <button
                onClick={api.saveAgent}
                disabled={state.saving || !state.name.trim() || isReadonly}
                className="px-5 py-1.5 text-sm font-medium rounded-lg border bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)] transition-all disabled:opacity-40 disabled:cursor-not-allowed border-[var(--border-default)] text-[var(--text-secondary)]"
              >
                {state.saving ? "Saving..." : "Save Changes"}
              </button>
            </div>
          </div>
        </div>

        {/* Config Content (Sidebar + Main) */}
        <div className="flex-1 flex overflow-hidden">
          <DesignerSectionNav integrationStatus={state.integrationStatus} activeSection={activeSection} setActiveSection={state.setActiveSection} />

          {/* Section Content */}
          <div className="flex-1 overflow-y-auto custom-scrollbar p-6">
            <div>
              {activeSection === "knowledge" && (
                <KnowledgeSection
                  agentId={selectedAgent?.id || null}
                  apiBase={API_BASE}
                  strictKnowledge={state.strictKnowledge}
                  setStrictKnowledge={state.setStrictKnowledge}
                  includeSourceReferences={state.includeSourceReferences}
                  setIncludeSourceReferences={state.setIncludeSourceReferences}
                  knowledgeBaseIds={state.knowledgeBaseIds}
                  setKnowledgeBaseIds={state.setKnowledgeBaseIds}
                />
              )}
              {activeSection === "identity" && <IdentitySection {...sharedProps} />}
              {activeSection === "tools" && <ToolsSection {...sharedProps} />}
              {activeSection === "behavior" && <BehaviorSection {...sharedProps} />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default AgentDesigner;
