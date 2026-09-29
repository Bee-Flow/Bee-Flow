import { ArrowLeft, X, Loader2 } from 'lucide-react';
import React, { useEffect, useEffectEvent, useState, useCallback, useRef, useId } from 'react';
import AgentOverview from './AgentOverview';
import { summariseDeleteBlock, blockHasFindings } from './deleteBlock';
import DeleteBlockedNotice from './DeleteBlockedNotice';
import useTranslation from '../../../hooks/useTranslation';
import { DEFAULT_AGENT_EMOJI } from '../../../utils/agentAvatar';
import { API_BASE, authFetch } from '../../../utils/helpers';
import Modal from '../../shared/Modal';
import { AgentEditorBootstrapProvider } from '../AgentWizard/AgentEditorBootstrapContext';
import BuilderSplit from '../AgentWizard/BuilderSplit';
import AgentWizard from '../AgentWizard/index';

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

    const [agents, setAgents] = useState([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState(null);
    const [selectedAgent, setSelectedAgent] = useState(null);
    // mode: 'idle' = no agent selected; show the card grid.
    //       'wizard' = the AI landing that writes a first version.
    //       'edit' = editing selectedAgent in BuilderSplit.
    const [mode, setMode] = useState(startInWizard ? 'wizard' : 'idle');
    const [pendingDelete, setPendingDelete] = useState(null);
    const [deleting, setDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState(null);
    // The 409 from DELETE /agents/:id, read into "what uses this" + "what could
    // not be checked". Non-null puts the dialog in its second stage; it is the
    // ONLY way to reach the override, because the server requires ?confirm=1
    // and will not take an unconfirmed delete of an agent anything still uses.
    const [deleteBlocked, setDeleteBlocked] = useState(null);

    const unsavedTitleId = useId();
    const deleteTitleId = useId();

    // Track in-flight list fetches so an unmount or rapid refetch can abort the
    // older request before its setState fires. React strict-mode double-invokes
    // effects in dev (mount → cleanup → mount); the setup re-arms the flag so
    // the second "mount" doesn't see a permanently-false ref left over by the
    // first cleanup — without this, every state setter inside fetchAgents was
    // skipped on the live mount and the loading spinner stuck forever.
    const listAbortRef = useRef(null);
    const mountedRef = useRef(true);
    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            if (listAbortRef.current) {
                try { listAbortRef.current.abort(); } catch (_) { /* noop */ }
            }
        };
    }, []);

    const fetchAgents = useCallback(async () => {
        if (listAbortRef.current) {
            try { listAbortRef.current.abort(); } catch (_) { /* noop */ }
        }
        const ctrl = new AbortController();
        listAbortRef.current = ctrl;
        setLoading(true);
        setLoadError(null);
        try {
            // `?usage=1` is opt-in omdat het een pass over elke routine, app en
            // pagina is (routes/agents/published.js). Dit scherm is de ENE plek
            // die het antwoord toont — de "also in 2 routines, 1 app"-helft van
            // de kaartvoet — dus hier wordt het gevraagd en nergens anders.
            // `/agents/system` kent de parameter niet en rekent geen tellingen
            // uit; die rijen dragen het veld daarom niet, en de voet zwijgt
            // erover in plaats van er een nul van te maken.
            const endpoint = systemMode ? `${API_BASE}/agents/system` : `${API_BASE}/agents/all?usage=1`;
            const res = await authFetch(endpoint, { signal: ctrl.signal });
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }
            const data = await res.json();
            if (!mountedRef.current || ctrl.signal.aborted) return;
            setAgents(Array.isArray(data) ? data : []);
        } catch (e) {
            if (e.name === 'AbortError') return;
            console.error('Failed to load agents', e);
            if (mountedRef.current) {
                setLoadError(e.message || 'Failed to load');
                setAgents([]);
            }
        } finally {
            if (mountedRef.current && listAbortRef.current === ctrl) {
                setLoading(false);
            }
        }
    }, [systemMode]);

    useEffect(() => { fetchAgents(); }, [fetchAgents]);

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
        setSelectedAgent({
            id: null,
            name: t('agent_studio.untitled'),
            description: '',
            system_prompt: '',
            embed_enabled: 0,
            is_published: 0,
            shared_groups: [],
            config: {
                avatar: DEFAULT_AGENT_EMOJI,
                enabledIntegrations: [],
                knowledge_base_ids: [],
                attachedSkillIds: [],
                memoryEnabled: false,
            },
        });
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

    // Open the in-app confirmation modal. The actual delete happens in confirmDelete().
    const requestDelete = (a) => {
        if (!a?.id) return;
        setDeleteError(null);
        setDeleteBlocked(null);
        setPendingDelete(a);
    };

    // `force` re-sends the same delete with ?confirm=1. That parameter is not
    // decoration: without it the server refuses to delete an agent that
    // anything still uses — and it refuses just as firmly when it could not
    // check. Until this second stage existed, no client sent it at all, so
    // deleting a published agent any colleague had chatted with simply failed
    // with a raw JSON body in the error line.
    const confirmDelete = async (force = false) => {
        const a = pendingDelete;
        if (!a?.id || deleting) return;
        setDeleting(true);
        setDeleteError(null);
        try {
            const res = await authFetch(
                `${API_BASE}/agents/${a.id}${force ? '?confirm=1' : ''}`,
                { method: 'DELETE' },
            );
            // 409 is not an error to show as text — it is the answer to
            // "what would this break", and it belongs in the dialog. Reading
            // it must never turn an unparsable body into "nothing uses this":
            // summariseDeleteBlock reports every kind as unchecked instead.
            if (res.status === 409) {
                let body = null;
                try { body = await res.json(); } catch (_) { /* leave null: unreadable */ }
                setDeleteBlocked(summariseDeleteBlock(body));
                return;
            }
            if (!res.ok) {
                // Guard res.text() — an HTML error page or a body-less response
                // would otherwise reject inside the throw, swallowing the real
                // status code.
                let detail = '';
                try { detail = await res.text(); } catch (_) { /* ignore */ }
                throw new Error(detail || `HTTP ${res.status}`);
            }
            if (selectedAgent?.id === a.id) { setSelectedAgent(null); setMode('idle'); }
            // Close the modal first so the user sees the action complete; the
            // refresh runs in the background and any failure surfaces via the
            // load-error banner rather than blocking the modal.
            setPendingDelete(null);
            fetchAgents();
        } catch (err) {
            setDeleteError(err.message);
        } finally {
            setDeleting(false);
        }
    };

    // Escape closes the delete-confirm modal (when not in-flight).
    const confirmDeleteFromKey = useEffectEvent(() => confirmDelete());
    useEffect(() => {
        if (!pendingDelete) return undefined;
        const onKey = (e) => {
            if (deleting) return;
            if (e.key === 'Escape') { setPendingDelete(null); return; }
            // Power-user accelerator: Cmd/Ctrl + Enter triggers the destructive
            // action, matching the pattern used by browser print dialogs and
            // most modal-confirm UIs.
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                confirmDeleteFromKey();
            }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [pendingDelete, deleting]);

    // Escape closes the unsaved-changes modal.
    useEffect(() => {
        if (!pendingLeave) return undefined;
        const onKey = (e) => { if (e.key === 'Escape') setPendingLeave(null); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [pendingLeave]);

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
                    <div className="flex-1 min-h-0 flex flex-col">
                        {/* De landing tekent zelf geen terugweg en geen
                            "leeg beginnen"; beide horen hier, anders is de
                            wizard een doodlopende straat. */}
                        <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-[var(--border-default)]">
                            <button
                                type="button"
                                onClick={() => setMode('idle')}
                                className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] transition"
                            >
                                <ArrowLeft size={14} aria-hidden="true" />
                                {t('agent_studio.header.back_to_agents', 'Back to Agents')}
                            </button>
                            <button
                                type="button"
                                onClick={switchToManualGuarded}
                                className="h-8 px-2.5 rounded-lg text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] transition"
                            >
                                {t('agent_studio.create_empty', 'Create empty agent')}
                            </button>
                        </div>
                        <div className="flex-1 min-h-0">
                            <AgentWizard
                                user={user}
                                onClose={onClose}
                                onSwitchToManual={switchToManualGuarded}
                                onPublished={handleWizardPublished}
                            />
                        </div>
                    </div>
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
                <Modal
                    open
                    onClose={() => setPendingLeave(null)}
                    role="alertdialog"
                    size="md"
                    zIndex={1200}
                    labelledBy={unsavedTitleId}
                    title={<span id={unsavedTitleId}>{t('agent_studio.unsaved_title', 'Unsaved changes')}</span>}
                    footer={
                        <>
                            <button
                                onClick={() => setPendingLeave(null)}
                                className="px-4 py-2 rounded-full text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] transition"
                            >
                                {t('agent_studio.cancel', 'Cancel')}
                            </button>
                            <button
                                onClick={() => { const run = pendingLeave.run; setPendingLeave(null); setIsDirty(false); run(); }}
                                className="px-4 py-2 rounded-full text-sm bg-red-500 text-white hover:bg-red-600 transition"
                            >
                                {t('agent_studio.discard', 'Discard')}
                            </button>
                        </>
                    }
                >
                    <div className="text-sm text-[var(--text-secondary)]">
                        {t('agent_studio.unsaved_body', 'Your draft agent has not been saved yet. Leaving will discard these changes.')}
                    </div>
                </Modal>
            )}
            {pendingDelete && (
                <Modal
                    open
                    onClose={() => { if (!deleting) setPendingDelete(null); }}
                    role="alertdialog"
                    size="md"
                    zIndex={1000}
                    labelledBy={deleteTitleId}
                    // A delete that already came back "still in use" must not be
                    // dismissed by a click next to it.
                    disableBackdropClose
                    disableEscapeClose={deleting}
                    title={
                        <span id={deleteTitleId}>
                                {/* Three headings, not two. A 409 that found consumers
                                    and a 409 that could not check are both refusals, but
                                    only the first one may say "still in use" — the second
                                    would be a claim about a scan that did not answer. */}
                                {!deleteBlocked
                                    ? t('agent_studio.delete_title', 'Delete agent')
                                    : blockHasFindings(deleteBlocked)
                                        ? t('agent_studio.delete_blocked_title', 'This agent is still in use')
                                        : t('agent_studio.delete_blocked_unknown_title', 'Could not check what uses this agent')}
                        </span>
                    }
                    headerActions={
                        <button
                            onClick={() => { if (!deleting) setPendingDelete(null); }}
                            className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                            disabled={deleting}
                            aria-label={t('agent_studio.close', 'Close')}
                        >
                            <X size={18} />
                        </button>
                    }
                    footer={
                        <>
                            <button
                                onClick={() => { setDeleteError(null); setDeleteBlocked(null); setPendingDelete(null); }}
                                disabled={deleting}
                                className="px-4 py-2 rounded-full text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] disabled:opacity-50"
                            >
                                {t('agent_studio.cancel', 'Cancel')}
                            </button>
                            {/* An arrow function, NOT `onClick={confirmDelete}`: the handler's
                                first parameter is `force`, and a click event is truthy. Bound
                                bare, the first press would send ?confirm=1 and skip the very
                                check this dialog exists to show. */}
                            <button
                                onClick={() => confirmDelete(!!deleteBlocked)}
                                disabled={deleting}
                                className="px-4 py-2 rounded-full text-sm bg-red-500 text-white hover:bg-red-600 disabled:opacity-50 inline-flex items-center gap-1.5"
                            >
                                {deleting && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
                                <span>
                                    {deleting
                                        ? t('agent_studio.deleting', 'Deleting…')
                                        : deleteBlocked
                                            ? t('agent_studio.delete_anyway', 'Delete anyway')
                                            : t('agent_studio.delete', 'Delete')}
                                </span>
                            </button>
                        </>
                    }
                >
                    {deleteBlocked ? (
                        <DeleteBlockedNotice summary={deleteBlocked} />
                    ) : (
                        <div className="text-sm text-[var(--text-secondary)]">
                            {t('agent_studio.delete_confirm', { name: pendingDelete?.name || '' })}
                        </div>
                    )}
                    {deleteError && (
                        <div className="pt-2 text-xs text-red-500" role="alert">{deleteError}</div>
                    )}
                </Modal>
            )}
        </div>
        </AgentEditorBootstrapProvider>
    );
}
