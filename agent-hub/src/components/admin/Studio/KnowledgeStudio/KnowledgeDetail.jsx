import { Loader2, Plus } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AddSourcePanel, { messageFor } from './AddSourcePanel';
import { knowledgeApi } from './knowledgeApi';
import SettingsTab from './SettingsTab';
import SourcesTab from './SourcesTab';
import TestQuestionCard from './TestQuestionCard';
import useRelativeTime from '../../../../hooks/useRelativeTime';
import useTranslation from '../../../../hooks/useTranslation';
import useUsage from '../../../../hooks/useUsage';
import StudioSectionHeader, { PRIMARY_ACTION_STYLE } from '../../../shared/StudioSectionHeader';
import useConfirm from '../../../shared/useConfirm';
import UsedByTab from '../../../shared/UsedByTab';
import VisibilityCapsule from '../../../shared/VisibilityCapsule';

/** The tab ids, which are also the URL's third segment. */
export const TABS = Object.freeze(['sources', 'ask', 'settings', 'usage']);

/**
 * One knowledge base: the 48px Studio header, its four tabs, and the
 * sources beneath (Knowledge artboard 1a).
 *
 * ── THE TAB LIVES IN THE URL ────────────────────────────────────────
 * `…/knowledge/<id>/usage` has to be linkable, because that is where the
 * Agents section sends someone who asks "what would break if I removed
 * this knowledge base from this agent". A tab held in component state is a
 * tab nobody can link to, and the answer to that question is the whole
 * reason the Used-by tab exists.
 *
 * ── THE HEADER SAYS HOW CURRENT THE CONTENT IS ──────────────────────
 * The status chip is "Bijgewerkt 2 min geleden" — `lastContentAt`, which
 * K1a sets in `bumpKBVersion` only, so renaming the knowledge base does not
 * make it look freshly filled. That distinction is the reason the column
 * exists rather than reusing `updated_at`.
 */
export default function KnowledgeDetail({
    kbId,
    tab = 'sources',
    canManage = false,
    currentUserId = null,
    orgGroups = [],
    // The viewer's own organisation, for the one action that needs it: moving
    // a personal knowledge base into an org so it can be shared at all.
    orgId = null,
    onTab,
    onBack,
    onOpenSource,
    onOpenKb,
    onNavigate,
}) {
    const { t } = useTranslation();
    const rel = useRelativeTime();
    const { confirm, confirmDialog } = useConfirm();

    const [kb, setKb] = useState(null);
    const [sources, setSources] = useState([]);
    const [totals, setTotals] = useState(null);
    const [loading, setLoading] = useState(true);
    const [sourcesError, setSourcesError] = useState(null);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const [capsuleOpen, setCapsuleOpen] = useState(false);

    const { usage, unchecked, error: usageError, refetch: refetchUsage } = useUsage('kb', kbId);

    const loadKb = useCallback(async () => {
        if (!kbId) return;
        try {
            setKb(await knowledgeApi.get(kbId));
            setError(null);
        } catch (e) {
            setError(e.message || t('studio_misc.errors.load_kb', 'Could not load this knowledge base'));
        }
    }, [kbId, t]);

    const loadSources = useCallback(async () => {
        if (!kbId) return;
        try {
            const body = await knowledgeApi.listSources(kbId);
            setSources(Array.isArray(body?.sources) ? body.sources : []);
            setTotals(body?.totals || null);
            setSourcesError(null);
        } catch (e) {
            // A sources failure is NOT a KB failure: the header, the audience
            // capsule and the other tabs all still work, and replacing the
            // page with one error message would hide the controls the person
            // needs to fix whatever went wrong.
            setSourcesError(e.message || t('studio_misc.errors.load_sources', 'Could not load the sources'));
            setSources([]);
        }
    }, [kbId, t]);

    useEffect(() => {
        let alive = true;
        setLoading(true);
        Promise.all([loadKb(), loadSources()]).finally(() => { if (alive) setLoading(false); });
        return () => { alive = false; };
    }, [loadKb, loadSources]);

    const createSource = useCallback(async (payload) => {
        setBusy(true);
        try {
            await knowledgeApi.createSource(kbId, payload);
            await Promise.all([loadSources(), loadKb()]);
        } finally {
            setBusy(false);
        }
    }, [kbId, loadSources, loadKb]);

    /**
     * Uploading needs a source to hang the files on. The wrappers always
     * reuse the OLDEST upload bucket (K1b), so this reuses it too rather
     * than creating a second "Uploaded files" beside the first.
     */
    const uploadFiles = useCallback(async (files) => {
        setBusy(true);
        try {
            let bucket = sources.find(s => s.kind === 'upload') || null;
            if (!bucket) {
                const created = await knowledgeApi.createSource(kbId, {
                    kind: 'upload',
                    name: t('knowledge.upload_bucket', 'Uploaded files'),
                    config: {},
                });
                bucket = created?.source || created;
            }
            await knowledgeApi.uploadFiles(kbId, bucket.id, files);
            await Promise.all([loadSources(), loadKb()]);
        } catch (e) {
            setSourcesError(messageFor(t, e));
        } finally {
            setBusy(false);
        }
    }, [kbId, sources, loadSources, loadKb, t]);

    const removeSource = useCallback(async (source) => {
        const ok = await confirm({
            title: t('knowledge.sources.delete_title', 'Delete “{name}”?', { name: source.name }),
            description: t('knowledge.sources.delete_body', 'Its {count} documents leave this knowledge base. The original files stay where they are.', { count: Number(source.documentCount) || 0 }),
            confirmLabel: t('knowledge.sources.delete', 'Delete'),
            destructive: true,
        });
        if (!ok) return;
        try {
            await knowledgeApi.removeSource(kbId, source.id);
            await Promise.all([loadSources(), loadKb()]);
        } catch (e) {
            setSourcesError(e.message);
        }
    }, [confirm, kbId, loadSources, loadKb, t]);

    const renameSource = useCallback((source) => {
        // Renaming is the inline edit on the source detail's own header, so
        // the row menu takes you there rather than growing a second rename UI
        // that would have to be kept in step with it.
        onOpenSource?.(source.id);
    }, [onOpenSource]);

    /**
     * The header's primary action and the panel on the right are the same
     * affordance. Rather than a second copy of the seven buttons, the header
     * moves focus to the panel — which also makes the action reachable from
     * the keyboard, where the panel is otherwise a long way down the page.
     */
    const addPanelRef = useRef(null);
    const focusAddSource = useCallback(() => {
        const panel = addPanelRef.current;
        if (!panel) return;
        panel.scrollIntoView({ block: 'nearest' });
        panel.querySelector('button:not([disabled])')?.focus();
    }, []);

    const refreshSource = useCallback(async (source) => {
        try {
            await knowledgeApi.refreshSource(kbId, source.id);
            await loadSources();
        } catch (e) {
            setSourcesError(e.message);
        }
    }, [kbId, loadSources]);

    /**
     * Save a source's refresh schedule.
     *
     * The server arms it (`next_refresh_at`) as part of the same PATCH, so
     * there is no second call that could half-succeed and leave a schedule
     * on screen that never fires.
     */
    const setSchedule = useCallback(async (source, refresh) => {
        try {
            await knowledgeApi.updateSource(kbId, source.id, { refresh });
            await loadSources();
        } catch (e) {
            setSourcesError(e.message);
        }
    }, [kbId, loadSources]);

    const setAudience = useCallback(async (body) => {
        try {
            await knowledgeApi.setPublished(kbId, body);
            await loadKb();
        } catch (e) {
            setError(e.message);
        }
    }, [kbId, loadKb]);

    const tabs = useMemo(() => ([
        { id: 'sources', label: t('knowledge.tab_sources', 'Sources'), count: totals?.sourceCount ?? sources.length },
        { id: 'ask', label: t('knowledge.tab_ask', 'Test question') },
        { id: 'settings', label: t('knowledge.tab_settings', 'Settings') },
        { id: 'usage', label: t('usage.table_label', 'Used by'), count: usage?.length },
    ]), [t, totals, sources.length, usage]);

    if (loading) {
        return (
            <div className="h-full flex items-center justify-center" style={{ color: 'var(--text-tertiary)' }}>
                <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
                <span className="sr-only">{t('knowledge.loading', 'Loading…')}</span>
            </div>
        );
    }

    return (
        <div className="h-full flex flex-col overflow-hidden" data-testid="kb-detail-page" data-kb-id={kbId}>
            <StudioSectionHeader
                kind="kb"
                title={kb?.name || ''}
                onRename={canManage ? (next) => knowledgeApi.update(kbId, { name: next }).then(loadKb).catch(e => setError(e.message)) : undefined}
                statusChip={kb?.lastContentAt || kb?.last_content_at
                    ? t('knowledge.updated_chip', 'Updated {when}', { when: rel(kb.lastContentAt || kb.last_content_at) })
                    : t('knowledge.never_filled', 'Nothing in it yet')}
                tabs={tabs}
                activeTab={tab}
                onTab={onTab}
                onBack={onBack}
                backLabel={t('knowledge.back', 'Back to Knowledge')}
                capsule={(
                    <VisibilityCapsule
                        variant="capsule"
                        anchored
                        agent={kb}
                        open={capsuleOpen}
                        onToggle={() => setCapsuleOpen(v => !v)}
                        onClose={() => setCapsuleOpen(false)}
                        disabled={!canManage}
                        isPublished={!!kb?.is_published}
                        sharedGroups={kb?.shared_groups || []}
                        orgGroups={orgGroups}
                        confirmWidening
                        onSetPersonal={() => setAudience({ isPublished: false, sharedGroups: [] })}
                        onSetEntireOrg={() => setAudience({ isPublished: true, sharedGroups: [] })}
                        onToggleGroup={(gid) => {
                            const cur = kb?.shared_groups || [];
                            const next = cur.includes(gid) ? cur.filter(g => g !== gid) : [...cur, gid];
                            return setAudience({ isPublished: true, sharedGroups: next });
                        }}
                    />
                )}
                primary={canManage && tab === 'sources' ? (
                    <button
                        type="button"
                        onClick={focusAddSource}
                        className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                        style={{ ...PRIMARY_ACTION_STYLE, outlineColor: 'var(--accent-primary)' }}
                    >
                        <Plus className="w-3 h-3" aria-hidden="true" />
                        {t('knowledge.add_source', 'Add a source')}
                    </button>
                ) : null}
            />

            {error && (
                <p className="px-7 pt-3" role="alert" style={{ color: 'var(--error)', fontSize: 12 }}>{error}</p>
            )}

            <div className="flex-1 overflow-y-auto px-7 py-6">
                {tab === 'sources' && (
                    <div className="grid gap-5" style={{ gridTemplateColumns: 'minmax(0, 1fr) 400px' }}>
                        <SourcesTab
                            sources={sources}
                            totals={totals}
                            error={sourcesError}
                            canManage={canManage}
                            onOpen={(s) => onOpenSource?.(s.id)}
                            onRefresh={refreshSource}
                            onRename={renameSource}
                            onDelete={removeSource}
                            onSchedule={setSchedule}
                        />
                        <div className="flex flex-col gap-3.5">
                            <div ref={addPanelRef}>
                                <AddSourcePanel canManage={canManage} busy={busy} onCreate={createSource} onUpload={uploadFiles} kbName={kb?.name || ''} onNavigate={onNavigate} sources={sources} />
                            </div>
                            <TestQuestionCard kbId={kbId} />
                        </div>
                    </div>
                )}

                {tab === 'ask' && <div className="max-w-md"><TestQuestionCard kbId={kbId} /></div>}

                {tab === 'settings' && (
                    <SettingsTab
                        kb={kb}
                        // The SAME list the Used-by tab renders, from the one
                        // fetch in this component: the delete confirmation and
                        // the tab must not be able to disagree about what
                        // depends on this base while somebody is deciding
                        // whether to break it.
                        usage={usage}
                        // The kinds the server could NOT check. "I could not
                        // reach apps" and "no app uses this" are different
                        // statements, and only one of them is safe to press
                        // delete on — so it travels with the rows rather than
                        // being dropped at the client boundary.
                        unchecked={unchecked}
                        canManage={canManage}
                        currentUserId={currentUserId}
                        orgGroups={orgGroups}
                        orgId={orgId}
                        onNavigate={onNavigate}
                        onSaved={async () => { await loadKb(); refetchUsage(); }}
                        onDeleted={onBack}
                        // Straight into the copy: the point of duplicating is
                        // to work on the new one, and leaving the person on
                        // the original makes them hunt for what they just made.
                        onDuplicated={(copy) => { if (copy?.id) onOpenKb?.(copy.id); }}
                    />
                )}

                {tab === 'usage' && (
                    <UsedByTab
                        rows={usage}
                        error={usageError}
                        currentUserId={currentUserId}
                        onNavigate={onNavigate}
                        emptyText={t('knowledge.usage_empty', 'No agent, skill or automation uses this knowledge base yet.')}
                    />
                )}
            </div>

            {confirmDialog}
        </div>
    );
}
