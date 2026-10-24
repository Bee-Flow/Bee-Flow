import React, { useEffect, useState, useCallback } from 'react';
import AgentOverview from './AgentOverview';
import DeleteAgentModal from './DeleteAgentModal';
import { newDraftAgent } from './draftAgent';
import UnsavedChangesModal from './UnsavedChangesModal';
import useAgentDelete from './useAgentDelete';
import useAgentList from './useAgentList';
import WizardLanding from './WizardLanding';
import useTranslation from '../../../hooks/useTranslation';
import { AgentEditorBootstrapProvider } from '../AgentWizard/AgentEditorBootstrapContext';
import BuilderSplit from '../AgentWizard/BuilderSplit';
import type { AgentListRow } from './agentCardFacts';
import type { EditorAgent } from '../AgentWizard/builderSplit/editorTypes';
import type { AppUserLike } from '../../projects/workspace/types';

/**
 * Studio → Agents: the overview (A5) and the editor (A2/A3) in one screen.
 * Replaces the old AgentDesigner as the main entry point; the legacy form is still reachable
 * via "Advanced settings" for fields that the studio does not yet show (guardrails, embedding,
 * bubble widget, sharing).
 *
 * ── THREE STATES, NOT TWO ──────────────────────────────────────────
 *   idle    the card grid (AgentOverview) — the section root
 *   wizard  the AI landing that writes an agent from a single sentence
 *   edit    BuilderSplit, full screen
 *
 * Before A5 part C `idle` was the wizard landing and the list stood in a 264px sidebar
 * beside it. The grid took over that spot, so the wizard now has its own state — with a way
 * back and with the "start empty" exit. Without those two the landing would be a dead end:
 * it draws no back button itself, and `onSwitchToManual` (createDraft) had already become
 * unreachable.
 */
interface AgentStudioProps {
    user?: AppUserLike | null;
    onNavigate?: (page: string) => void;
    onEditingChange?: (editing: boolean) => void;
    initialAgentId?: React.SetStateAction<string | null>;
    onClose?: (() => void) | null;
    hasPermission?: (perm: string) => boolean;
    systemMode?: boolean;
    startInWizard?: boolean;
}

export default function AgentStudio({ user, initialAgentId = null, onClose, onNavigate, hasPermission = () => true, systemMode = false, startInWizard = false, onEditingChange }: AgentStudioProps) {
    const { t } = useTranslation();

    const { agents, loading, loadError, fetchAgents } = useAgentList(systemMode);
    const [selectedAgent, setSelectedAgent] = useState<AgentListRow | null>(null);
    // mode: 'idle' = no agent selected; show the card grid.
    //       'wizard' = the AI landing that writes a first version.
    //       'edit' = editing selectedAgent in BuilderSplit.
    const [mode, setMode] = useState(startInWizard ? 'wizard' : 'idle');

    const isEditing = mode === 'edit' && !!selectedAgent;
    useEffect(() => {
        onEditingChange?.(isEditing);
        return () => { onEditingChange?.(false); };
    }, [isEditing, onEditingChange]);

    // Track whether the initial deep-link id has been resolved (matched against
    // the loaded agents list, or confirmed absent). The reflective URL effect
    // below is gated on this so a hard-refresh of /app/studio/agents/<id>
    // doesn't get clobbered to /app/studio/agents before the agent list arrives
    // and the auto-select effect runs.
    //
    // The flag is keyed on the *current* initialAgentId — if the parent passes
    // a new id (e.g. in-app nav from /studio/agents/A to /B), we re-bootstrap
    // instead of being stuck on A.
    const [bootstrappedFor, setBootstrappedFor] = useState(initialAgentId ? null : 'none');

    // Auto-select agent passed in via URL once agents have loaded.
    useEffect(() => {
        if (bootstrappedFor === initialAgentId || bootstrappedFor === 'none') return;
        if (agents.length === 0 && !loadError) return; // wait for load
        const found = initialAgentId ? agents.find(a => a.id === initialAgentId) : null;
        if (found) { setSelectedAgent(found); setMode('edit'); }
        else if (initialAgentId) {
            // Deep-link target no longer exists — drop to list view.
            setSelectedAgent(null);
            setMode('idle');
        }
        setBootstrappedFor(initialAgentId || 'none');
    }, [bootstrappedFor, initialAgentId, agents, loadError]);

    // Reflect the open agent in the URL so it's bookmarkable / visible to the user.
    useEffect(() => {
        if (!onNavigate) return;
        if (bootstrappedFor === null) return; // not yet bootstrapped
        if (mode === 'edit' && selectedAgent?.id) {
            onNavigate(`studio/agents/${selectedAgent.id}`);
        } else if (mode === 'idle' || mode === 'wizard') {
            // The wizard belongs to the section root: it does not (yet) have its own route. A draft in
            // `edit` deliberately does NOT navigate — that would set the URL to the list while you are
            // in the editor.
            onNavigate('studio/agents');
        }
    }, [bootstrappedFor, mode, selectedAgent?.id, onNavigate]);

    // Local-only draft: the agent isn't persisted until the user hits Save in
    // the editor. Until then it has no id, doesn't appear in the sidebar list,
    // and edits stay in memory.
    const createDraft = useCallback(() => {
        setSelectedAgent(newDraftAgent(t));
        setMode('edit');
    }, [t]);

    // Track unsaved state from BuilderSplit so we can guard leave actions.
    const [isDirty, setIsDirty] = useState(false);
    const [pendingLeave, setPendingLeave] = useState<{ run: () => void } | null>(null); // null | { run: () => void }
    const guardLeave = useCallback((run: () => void) => {
        if (mode === 'edit' && selectedAgent && !selectedAgent.id && isDirty) {
            setPendingLeave({ run });
        } else {
            run();
        }
    }, [mode, selectedAgent, isDirty]);

    const selectAgent = useCallback((a: AgentListRow) => guardLeave(() => { setSelectedAgent(a); setMode('edit'); setIsDirty(false); }), [guardLeave]);

    // Wizard "switch to manual" — must respect the unsaved-changes guard so a
    // dirty draft isn't silently replaced when the user clicks "Build it from
    // scratch" in the wizard while a previous draft is still unsaved.
    const switchToManualGuarded = useCallback(() => guardLeave(createDraft), [guardLeave, createDraft]);

    // BuilderSplit publish handler — memoized to avoid re-running BuilderSplit
    // effects that depend on this callback identity.
    const handlePublished = useCallback(async (updated: AgentListRow) => {
        await fetchAgents();
        if (updated) setSelectedAgent(updated);
        setIsDirty(false);
    }, [fetchAgents]);

    const handleWizardPublished = useCallback(async (newAgent: { id?: string | null; } | null | undefined) => {
        await fetchAgents();
        if (newAgent?.id) { setSelectedAgent(newAgent); setMode('edit'); }
        else setMode('idle');
    }, [fetchAgents]);

    const handleBack = useCallback(() => guardLeave(() => { setSelectedAgent(null); setMode('idle'); setIsDirty(false); }), [guardLeave]);


    const {
        pendingDelete, deleting, deleteError, deleteBlocked,
        requestDelete, confirmDelete, dismissDelete, cancelDelete,
    } = useAgentDelete({
        fetchAgents,
        onDeleted: (id) => { if (selectedAgent?.id === id) { setSelectedAgent(null); setMode('idle'); } },
    });
    const cancelLeave = useCallback(() => setPendingLeave(null), []);

    return (
        <AgentEditorBootstrapProvider>
        <div className="flex h-full bg-[var(--bg-primary)]">
            {/* Content */}
            <section className="flex-1 min-w-0 flex flex-col">
                {mode === 'idle' && (
                    <AgentOverview
                        t={t}
                        agents={agents}
                        loading={loading}
                        error={loadError}
                        onRetry={fetchAgents}
                        onOpen={selectAgent}
                        selectedId={selectedAgent?.id || null}
                        systemMode={systemMode}
                        // Who is looking. Without this, the card footer cannot make "Only you" true (it is a claim
                        // about the OWNER) and falls back to the neutral form.
                        viewerId={user?.id || null}
                        // BFSF-271 + "unknown narrows": the card decides for itself whether it shows the bin (only
                        // when can_edit === true). This is only about whether THIS SCREEN may delete.
                        onDelete={!systemMode && hasPermission('manage_agents') ? requestDelete : null}
                        onCreate={!systemMode && hasPermission('manage_agents') ? () => guardLeave(() => setMode('wizard')) : null}
                    />
                )}
                {mode === 'wizard' && (
                    <WizardLanding
                        t={t}
                        user={user}
                        onClose={onClose}
                        onBack={() => setMode('idle')}
                        onSwitchToManual={switchToManualGuarded}
                        onPublished={handleWizardPublished}
                    />
                )}
                {mode === 'edit' && selectedAgent && (
                    <BuilderSplit
                        key={selectedAgent.id || 'draft'}
                        agent={selectedAgent as EditorAgent}
                        readOnly={selectedAgent.can_edit === false}
                        user={user}
                        plan={null}
                        history={[]}
                        onBack={handleBack}
                        onDirtyChange={setIsDirty}
                        onPublished={handlePublished}
                        // The editor points to other Studio sections (the meeting tip on "Can use" goes to the
                        // sources of a knowledge base). Without this pass-through that card draws no button —
                        // better no button than a button that does nothing.
                        onNavigate={onNavigate}
                        onDeleted={() => {
                            // Server has confirmed the agent is gone; deselect and drop
                            // back to the list so the URL doesn't keep reflecting a
                            // dead id (and so a hard-refresh doesn't re-fetch it).
                            setSelectedAgent(null);
                            setMode('idle');
                            fetchAgents();
                        }}
                    />
                )}
            </section>

            {pendingLeave && (
                <UnsavedChangesModal
                    t={t}
                    onCancel={cancelLeave}
                    onDiscard={() => { const run = pendingLeave.run; setPendingLeave(null); setIsDirty(false); run(); }}
                />
            )}
            {pendingDelete && (
                <DeleteAgentModal
                    t={t}
                    target={pendingDelete}
                    deleting={deleting}
                    deleteBlocked={deleteBlocked}
                    deleteError={deleteError}
                    onDismiss={dismissDelete}
                    onCancel={cancelDelete}
                    onConfirm={confirmDelete}
                />
            )}
        </div>
        </AgentEditorBootstrapProvider>
    );
}
