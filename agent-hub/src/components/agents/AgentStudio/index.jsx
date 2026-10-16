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

/**
 * Studio → Agents: het overzicht (A5) en de editor (A2/A3) in één scherm.
 * Vervangt de oude AgentDesigner als hoofdingang; het legacy-formulier is nog
 * bereikbaar via "Advanced settings" voor velden die de studio nog niet toont
 * (guardrails, embedding, bubble widget, sharing).
 *
 * ── DRIE TOESTANDEN, NIET TWEE ──────────────────────────────────────
 *   idle    het kaartraster (AgentOverview) — de sectiewortel
 *   wizard  de AI-landing die uit één zin een agent schrijft
 *   edit    BuilderSplit, schermvullend
 *
 * Vóór A5 deel C was `idle` de wizard-landing en stond de lijst in een 264px
 * zijbalk ernaast. Het raster nam die plek over, dus de wizard heeft nu een
 * eigen toestand — mét een weg terug en mét de "leeg beginnen"-uitgang. Zonder
 * die twee zou de landing een doodlopende straat zijn: hij tekent zelf geen
 * terugknop, en `onSwitchToManual` (createDraft) was al onbereikbaar geworden.
 */
export default function AgentStudio({ user, initialAgentId = null, onClose, onNavigate, hasPermission = () => true, systemMode = false, startInWizard = false, onEditingChange }) {
    const { t } = useTranslation();

    const { agents, loading, loadError, fetchAgents } = useAgentList(systemMode);
    const [selectedAgent, setSelectedAgent] = useState(null);
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
            // De wizard hoort bij de sectiewortel: hij heeft (nog) geen eigen
            // route. Een concept in `edit` navigeert bewust NIET — dat zou de
            // URL naar de lijst zetten terwijl je in de editor staat.
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
    const [pendingLeave, setPendingLeave] = useState(null); // null | { run: () => void }
    const guardLeave = useCallback((run) => {
        if (mode === 'edit' && selectedAgent && !selectedAgent.id && isDirty) {
            setPendingLeave({ run });
        } else {
            run();
        }
    }, [mode, selectedAgent, isDirty]);

    const selectAgent = useCallback((a) => guardLeave(() => { setSelectedAgent(a); setMode('edit'); setIsDirty(false); }), [guardLeave]);

    // Wizard "switch to manual" — must respect the unsaved-changes guard so a
    // dirty draft isn't silently replaced when the user clicks "Build it from
    // scratch" in the wizard while a previous draft is still unsaved.
    const switchToManualGuarded = useCallback(() => guardLeave(createDraft), [guardLeave, createDraft]);

    // BuilderSplit publish handler — memoized to avoid re-running BuilderSplit
    // effects that depend on this callback identity.
    const handlePublished = useCallback(async (updated) => {
        await fetchAgents();
        if (updated) setSelectedAgent(updated);
        setIsDirty(false);
    }, [fetchAgents]);

    const handleWizardPublished = useCallback(async (newAgent) => {
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
                        // Wie er kijkt. Zonder dit kan de kaartvoet "Only you"
                        // niet waarmaken (het is een bewering over de EIGENAAR)
                        // en valt hij terug op de neutrale vorm.
                        viewerId={user?.id || null}
                        // BFSF-271 + "onbekend versmalt": de kaart beslist zelf of
                        // ze de prullenbak toont (alleen bij can_edit === true).
                        // Hier gaat alleen over of dit SCHERM mag verwijderen.
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
                        agent={selectedAgent}
                        readOnly={selectedAgent.can_edit === false}
                        user={user}
                        plan={null}
                        history={[]}
                        onBack={handleBack}
                        onDirtyChange={setIsDirty}
                        onPublished={handlePublished}
                        // De editor wijst naar andere Studio-secties (de
                        // meeting-tip op "Kan gebruiken" gaat naar de bronnen
                        // van een kennisbank). Zonder deze doorgifte tekent
                        // die kaart geen knop — liever geen knop dan een
                        // knop die niets doet.
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
