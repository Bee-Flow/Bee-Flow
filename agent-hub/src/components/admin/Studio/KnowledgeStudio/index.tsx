import React, { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { knowledgeApi, type KbSource, type KbSuggestion, type KbUsageSummary } from './knowledgeApi';
import KnowledgeDetail, { TABS } from './KnowledgeDetail';
import KnowledgeOverview from './KnowledgeOverview';
import SourceDetail from './SourceDetail';
import { readOrgGroups, type OrgGroup } from '../../../../api/queries/orgGroups';
import useTranslation from '../../../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../../../utils/helpers';
import scopedStorage from '../../../../utils/scopedStorage';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import { mutate, ApiError } from '../../../../api/mutate';

/**
 * Studio → Knowledge. Three screens behind one route
 * (`/app/studio/knowledge[/:id[/:tab[/:sourceId]]]`):
 *
 *   no id            → KnowledgeOverview   (artboard 1c-right)
 *   id               → KnowledgeDetail     (artboard 1a)
 *   id + sourceId    → SourceDetail        (artboard 1b)
 *
 * ── WHY THE URL CARRIES THE TAB AND THE SOURCE ──────────────────────
 * Both are things one person sends another: "look at what still uses this"
 * (the Used-by tab) and "these two files were skipped" (a source). A screen
 * you cannot link to is a screen you have to describe over the phone.
 *
 * ── DEEP-LINK BOOTSTRAP ─────────────────────────────────────────────
 * The AgentStudio pattern (components/agents/AgentStudio/index.jsx:97-120):
 * a hard refresh on `/app/studio/knowledge/<id>` must not be clobbered back
 * to the list by the reflective URL effect before the list has loaded and
 * confirmed the id. The bootstrap flag is keyed on the CURRENT incoming id,
 * so in-app navigation from one knowledge base to another re-bootstraps
 * rather than staying stuck on the first.
 */
/** Dismissed nudges, per person, per browser. Never a shared decision. */
const HIDDEN_SUGGESTIONS_KEY = 'knowledge.suggestions.hidden';

/**
 * The one nudge to show, if any: highest-scoring first, skipping the ones
 * this person has already waved away. One at a time on purpose — three
 * stacked suggestions read as a to-do list somebody else wrote.
 */
export function firstVisibleSuggestion(t: TranslateFn, suggestions: KbSuggestion[], hidden: Set<string>) {
    const list = Array.isArray(suggestions) ? suggestions : [];
    const pick = list.find(s => s && !hidden.has(`${s.kbId}:${s.agentId}`));
    if (!pick) return null;
    return {
        ...pick,
        text: t(
            'knowledge.suggestion_text',
            '“{kb}” isn’t used by anything, and “{agent}” answers with no knowledge at all.',
            { kb: pick.kbName, agent: pick.agentName },
        ),
    };
}

interface KnowledgeStudioProps {
    user?: { id?: string; organizationId?: string } | null;
    initialKbId?: string | null;
    initialKbTab?: string | null;
    initialSourceId?: string | null;
    hasPermission?: (permission: string) => boolean;
    onNavigate?: ((target: string) => void) | null;
}

export default function KnowledgeStudio({
    user = null,
    initialKbId = null,
    initialKbTab = null,
    initialSourceId = null,
    hasPermission = () => true,
    onNavigate,
}: KnowledgeStudioProps) {
    const { t } = useTranslation();
    const [kbId, setKbId] = useState(initialKbId && initialKbId !== 'new' ? initialKbId : null);
    const [tab, setTab] = useState(initialKbTab && TABS.includes(initialKbTab) ? initialKbTab : 'sources');
    const [sourceId, setSourceId] = useState(initialSourceId || null);
    const [source, setSource] = useState<KbSource | null>(null);
    const [creating, setCreating] = useState(initialKbId === 'new');
    const [createError, setCreateError] = useState<string | null>(null);
    const [orgGroups, setOrgGroups] = useState<OrgGroup[]>([]);
    const [usageByKb, setUsageByKb] = useState<Record<string, KbUsageSummary> | null>(null);
    const [suggestions, setSuggestions] = useState<KbSuggestion[]>([]);
    const [hidden, setHidden] = useState(() => new Set<string>(scopedStorage.getJSON<string[]>(HIDDEN_SUGGESTIONS_KEY, []) || []));

    const canManage = hasPermission('manage_knowledge');

    // Adopt deep-link changes, INCLUDING the change to null — otherwise Back
    // from a knowledge base leaves the detail on screen (the Approvals /
    // Datatables rule).
    const last = React.useRef({ initialKbId, initialKbTab, initialSourceId });
    useEffect(() => {
        const prev = last.current;
        if (prev.initialKbId !== initialKbId) {
            setKbId(initialKbId && initialKbId !== 'new' ? initialKbId : null);
            setCreating(initialKbId === 'new');
        }
        if (prev.initialKbTab !== initialKbTab) setTab(initialKbTab && TABS.includes(initialKbTab) ? initialKbTab : 'sources');
        if (prev.initialSourceId !== initialSourceId) setSourceId(initialSourceId || null);
        last.current = { initialKbId, initialKbTab, initialSourceId };
    }, [initialKbId, initialKbTab, initialSourceId]);

    // The audience capsule needs the org's groups to offer any. A failure
    // here costs the group list and nothing else — the capsule still offers
    // personal and organisation-wide.
    useEffect(() => {
        let alive = true;
        readOrgGroups()
            .then(g => { if (alive) setOrgGroups(g ?? []); })
            .catch(() => {});
        return () => { alive = false; };
    }, []);

    /**
     * The overview's pills and its nudge.
     *
     * Both are chrome: a failure costs the pills, never the list. `usageByKb`
     * stays NULL until it has actually loaded, which is what
     * `KnowledgeOverview` reads to draw nothing rather than "used by nothing"
     * — the two are opposite claims and only one of them is safe to guess.
     */
    const loadOverviewExtras = useCallback(() => {
        knowledgeApi.usageSummary()
            .then(body => setUsageByKb(body?.summary || {}))
            .catch(() => setUsageByKb(null));
        knowledgeApi.suggestions()
            .then(body => setSuggestions(Array.isArray(body?.suggestions) ? body.suggestions : []))
            .catch(() => setSuggestions([]));
    }, []);

    useEffect(() => {
        if (kbId) return;      // only the overview needs them
        loadOverviewExtras();
    }, [kbId, loadOverviewExtras]);

    /** "Not this one." Per person, per browser — never a shared decision. */
    const hideSuggestion = useCallback((suggestion: KbSuggestion & { text: string }) => {
        setHidden((prev) => {
            const next = new Set(prev);
            next.add(`${suggestion.kbId}:${suggestion.agentId}`);
            scopedStorage.setJSON(HIDDEN_SUGGESTIONS_KEY, [...next]);
            return next;
        });
    }, []);

    /**
     * "Nextcloud handleidingen looks like it belongs to Nextcloud Buddy."
     *
     * Accepting it is the ordinary agent save, so it runs the SAME validation
     * a person clicking through the agent designer would — including the
     * usage-context check. A shortcut that wrote the id straight into the
     * config would be a second way to attach a knowledge base, and the one
     * that skips the rules.
     */
    const acceptSuggestion = useCallback(async (suggestion: KbSuggestion & { text: string }) => {
        try {
            const res = await authFetch(`${API_BASE}/api/agents/${encodeURIComponent(suggestion.agentId)}`);
            if (!res.ok) throw new Error('agent');
            const agent = await res.json();
            const config = { ...(agent?.config || {}) };
            const current = Array.isArray(config.knowledge_base_ids) ? config.knowledge_base_ids : [];
            if (current.includes(suggestion.kbId)) { loadOverviewExtras(); return; }
            config.knowledge_base_ids = [...current, suggestion.kbId];
            try {
                await mutate(`${API_BASE}/api/agents/${encodeURIComponent(suggestion.agentId)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ config }),
            });
            } catch (err) {
                if (!(err instanceof ApiError)) throw err;
                throw new Error('save');
            }
            loadOverviewExtras();
        } catch (_) {
            // A nudge that cannot be taken is dismissed rather than left
            // sitting there offering an action that does nothing.
            hideSuggestion(suggestion);
        }
    }, [loadOverviewExtras, hideSuggestion]);

    /** The single place that moves the URL and the state together. */
    const go = useCallback((nextKb: string | null, nextTab: string = 'sources', nextSource: string | null = null) => {
        setKbId(nextKb);
        setTab(nextTab);
        setSourceId(nextSource);
        setCreating(false);
        if (!onNavigate) return;
        if (!nextKb) { onNavigate('studio/knowledge'); return; }
        const parts = ['studio/knowledge', nextKb, nextTab];
        if (nextSource) parts.push(nextSource);
        onNavigate(parts.join('/'));
    }, [onNavigate]);

    // The source row the detail screen draws its header from. Fetched by id
    // so a hard refresh straight onto `…/<kb>/sources/<sid>` has it too.
    // A source id that no longer resolves drops back to the tab rather than
    // rendering a header with no name in it — the CURRENT tab, not the one
    // this load started on.
    const dropToTab = useEffectEvent(() => go(kbId, tab, null));
    useEffect(() => {
        let alive = true;
        if (!kbId || !sourceId) { setSource(null); return undefined; }
        knowledgeApi.listSources(kbId)
            .then(body => {
                if (!alive) return;
                const found = (body?.sources || []).find((s: KbSource) => s.id === sourceId) || null;
                setSource(found);
                if (!found) dropToTab();
            })
            .catch(() => { if (alive) setSource(null); });
        return () => { alive = false; };
    }, [kbId, sourceId]);

    const create = useCallback(async () => {
        setCreating(true);
        setCreateError(null);
        try {
            const made = await knowledgeApi.create({ name: t('knowledge.untitled', 'New knowledge base') });
            const id = made?.id || made?.kb?.id;
            if (id) { go(id, 'sources', null); return; }
            // A 200 with no id is not a success we can navigate to.
            setCreateError(t('knowledge.err_create', 'Could not create a knowledge base.'));
        } catch (e) {
            setCreateError((e as Error)?.message || t('knowledge.err_create', 'Could not create a knowledge base.'));
        }
        setCreating(false);
    }, [go, t]);

    /**
     * `/app/studio/knowledge/new` is where the Studio "New" menu sends
     * someone (studioApps.jsx `create`), and it means "make one and open
     * it" — there is no create FORM to land on. Without this the route
     * rendered the overview with its create button disabled, which is the
     * one screen where the button had to work.
     *
     * Guarded by a ref rather than by `creating`, so a failed create does
     * not immediately retry itself in a loop.
     */
    const createRequested = useRef(false);
    useEffect(() => {
        if (initialKbId !== 'new') { createRequested.current = false; return; }
        if (createRequested.current || !canManage) return;
        createRequested.current = true;
        create();
    }, [initialKbId, canManage, create]);

    // The breadcrumb on the source screen names the knowledge base it sits
    // in. That name lives on the KB, not on the source row, so a hard
    // refresh straight onto a source has to ask for it.
    const [kbName, setKbName] = useState<string | null>(null);
    useEffect(() => {
        let alive = true;
        if (!kbId) { setKbName(null); return undefined; }
        knowledgeApi.get(kbId)
            .then(k => { if (alive) setKbName(k?.name || null); })
            .catch(() => { if (alive) setKbName(null); });
        return () => { alive = false; };
    }, [kbId]);

    if (kbId && sourceId && source) {
        return (
            <SourceDetail
                kbId={kbId}
                kbName={kbName}
                source={source}
                canManage={canManage}
                onBack={() => go(kbId, tab, null)}
                onChanged={() => { /* the detail reloads itself; nothing above it caches counts */ }}
                // The name lives in this component's copy of the source row,
                // so a rename has to land here too or the header reverts to
                // the old name on the next render.
                onRenamed={(sid, name) => setSource(prev => (prev && prev.id === sid ? { ...prev, name } : prev))}
                onSchedule={async (sid, refresh) => {
                    const body = await knowledgeApi.updateSource(kbId, sid, { refresh });
                    // Re-read from the answer rather than assuming: the server
                    // decides the armed `nextRefreshAt`, and the header shows it.
                    setSource(body?.source || null);
                }}
            />
        );
    }

    if (kbId) {
        return (
            <KnowledgeDetail
                key={kbId}
                kbId={kbId}
                tab={tab}
                canManage={canManage}
                currentUserId={user?.id || null}
                orgGroups={orgGroups}
                orgId={user?.organizationId || null}
                onTab={(next: string|undefined) => go(kbId, next, null)}
                onBack={() => go(null)}
                onOpenSource={(sid) => go(kbId, tab, sid)}
                onOpenKb={(id: string) => go(id, 'sources', null)}
                onNavigate={onNavigate}
            />
        );
    }

    return (
        <KnowledgeOverview
            hasPermission={hasPermission}
            onOpen={(id: string) => go(id, 'sources', null)}
            onCreate={creating ? undefined : create}
            createError={createError}
            usageByKb={usageByKb}
            suggestion={firstVisibleSuggestion(t, suggestions, hidden)}
            onAcceptSuggestion={acceptSuggestion}
            onDismissSuggestion={hideSuggestion}
        />
    );
}
