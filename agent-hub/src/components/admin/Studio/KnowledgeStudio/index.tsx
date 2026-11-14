import React, { useCallback, useEffect, useEffectEvent, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useQuery } from '@tanstack/react-query';
import { knowledgeApi, type KbSource, type KbSuggestion, type KbUsageSummary } from './knowledgeApi';
import KnowledgeDetail, { TABS } from './KnowledgeDetail';
import KnowledgeOverview from './KnowledgeOverview';
import SourceDetail from './SourceDetail';
import { useOrgGroupsQuery, type OrgGroup } from '@/api/queries/orgGroups';
import useTranslation from '@/hooks/useTranslation';
import scopedStorage from '@/utils/scopedStorage';
import type { TranslateFn } from '@/hooks/useTranslation';
import { ApiError, RefusedError } from '@/api/mutate';
import { apiRequest } from '@/api/typedRequest';

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
function firstVisibleSuggestion(t: TranslateFn, suggestions: KbSuggestion[], hidden: Set<string>) {
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

interface DeepLinkArgs {
    initialKbId: string | null;
    initialKbTab: string | null;
    initialSourceId: string | null;
    setKbId: (id: string | null) => void;
    setCreating: (creating: boolean) => void;
    setTab: (tab: string) => void;
    setSourceId: (id: string | null) => void;
}

/**
 * Adopt deep-link changes, INCLUDING the change to null — otherwise Back
 * from a knowledge base leaves the detail on screen (the Approvals /
 * Datatables rule). The setters are the studio's useState setters.
 */
function useAdoptDeepLink({ initialKbId, initialKbTab, initialSourceId, setKbId, setCreating, setTab, setSourceId }: DeepLinkArgs) {
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
    }, [initialKbId, initialKbTab, initialSourceId, setKbId, setCreating, setTab, setSourceId]);
}

/**
 * The overview's pills and its nudge, loaded while no knowledge base is open.
 *
 * Both are chrome: a failure costs the pills, never the list. `usageByKb`
 * stays NULL until it has actually loaded, which is what
 * `KnowledgeOverview` reads to draw nothing rather than "used by nothing"
 * — the two are opposite claims and only one of them is safe to guess.
 */
function useOverviewExtras(kbId: string | null) {
    // Only the overview needs them; each visit to it reads them again.
    const usage = useQuery<Record<string, KbUsageSummary> | null>({
        ...KNOWLEDGE_READ,
        queryKey: ['knowledgeStudio', 'usageSummary'],
        enabled: !kbId,
        queryFn: async () => {
            try { return (await knowledgeApi.usageSummary())?.summary || {}; } catch { return null; }
        },
    });
    const nudges = useQuery<KbSuggestion[]>({
        ...KNOWLEDGE_READ,
        queryKey: ['knowledgeStudio', 'suggestions'],
        enabled: !kbId,
        queryFn: async () => {
            try {
                const body = await knowledgeApi.suggestions();
                return Array.isArray(body?.suggestions) ? body.suggestions : [];
            } catch { return []; }
        },
    });
    const { refetch: refetchUsage } = usage;
    const { refetch: refetchNudges } = nudges;
    const loadOverviewExtras = useCallback(() => { void refetchUsage(); void refetchNudges(); }, [refetchUsage, refetchNudges]);
    return { usageByKb: usage.data ?? null, suggestions: nudges.data ?? NO_SUGGESTIONS, loadOverviewExtras };
}

/** Every read here is asked again on each visit and never retried: a failure is an answer (null or empty). */
const KNOWLEDGE_READ = { staleTime: 0, retry: false, refetchOnReconnect: false, structuralSharing: false } as const;
const NO_SUGGESTIONS: KbSuggestion[] = [];
const NO_GROUPS: OrgGroup[] = [];

/**
 * The row of the open source, read by id so a hard refresh straight onto
 * `…/<kb>/sources/<sid>` has it too. Each answer seeds the studio's copy (a
 * rename or reschedule then edits it); a source id that no longer resolves
 * drops back to the CURRENT tab rather than rendering a header with no name.
 */
function useOpenSource(kbId: string | null, sourceId: string | null, dropToTab: () => void): [KbSource | null, Dispatch<SetStateAction<KbSource | null>>] {
    const [source, setSource] = useState<KbSource | null>(null);
    const open = !!kbId && !!sourceId;
    const list = useQuery<KbSource[] | null>({
        ...KNOWLEDGE_READ,
        queryKey: ['knowledgeStudio', 'sources', kbId, sourceId],
        enabled: open,
        queryFn: async () => {
            try { return (await knowledgeApi.listSources(kbId as string))?.sources || []; } catch { return null; }
        },
    });
    const [seeded, setSeeded] = useState<KbSource[] | null | undefined>(undefined);
    if (!open) {
        if (source !== null) setSource(null);
        if (seeded !== undefined) setSeeded(undefined);
    } else if (list.data !== undefined && list.data !== seeded) {
        setSeeded(list.data);
        setSource(list.data?.find((s: KbSource) => s.id === sourceId) || null);
    }
    const missing = open && Array.isArray(list.data) && !list.data.some((s: KbSource) => s.id === sourceId);
    const drop = useEffectEvent(dropToTab);
    useEffect(() => { if (missing) drop(); }, [missing]);
    return [source, setSource];
}

/** The name of the open knowledge base, for the breadcrumb on the source screen. */
function useKbName(kbId: string | null): string | null {
    const kb = useQuery<string | null>({
        ...KNOWLEDGE_READ,
        queryKey: ['knowledgeStudio', 'kbName', kbId],
        enabled: !!kbId,
        queryFn: async () => {
            try { return (await knowledgeApi.get(kbId as string))?.name || null; } catch { return null; }
        },
    });
    return kbId ? (kb.data ?? null) : null;
}

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
function useCreateOnNewRoute(initialKbId: string | null, canManage: boolean, create: () => Promise<void>) {
    const createRequested = useRef(false);
    useEffect(() => {
        if (initialKbId !== 'new') { createRequested.current = false; return; }
        if (createRequested.current || !canManage) return;
        createRequested.current = true;
        create();
    }, [initialKbId, canManage, create]);
}


interface KbSourceScreenProps {
    kbId: string;
    kbName: string | null;
    source: KbSource;
    canManage: boolean;
    onBack: () => void;
    setSource: Dispatch<SetStateAction<KbSource | null>>;
}

/** One source of a knowledge base, with the studio's copy of the row kept in step on rename and reschedule. */
function KbSourceScreen({ kbId, kbName, source, canManage, onBack, setSource }: KbSourceScreenProps) {
    return (
        <SourceDetail
            kbId={kbId}
            kbName={kbName}
            source={source}
            canManage={canManage}
            onBack={onBack}
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
    const [creating, setCreating] = useState(initialKbId === 'new');
    const [createError, setCreateError] = useState<string | null>(null);
    const [hidden, setHidden] = useState(() => new Set<string>(scopedStorage.getJSON<string[]>(HIDDEN_SUGGESTIONS_KEY, []) || []));

    const canManage = hasPermission('manage_knowledge');

    useAdoptDeepLink({ initialKbId, initialKbTab, initialSourceId, setKbId, setCreating, setTab, setSourceId });

    // The audience capsule needs the org's groups to offer any. A failure
    // here costs the group list and nothing else — the capsule still offers
    // personal and organisation-wide.
    const { data: orgGroups = NO_GROUPS } = useOrgGroupsQuery();

    const { usageByKb, suggestions, loadOverviewExtras } = useOverviewExtras(kbId);

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
            let res: Response;
            try {
                res = await apiRequest('GET /agents/{id}', { params: { id: suggestion.agentId } });
            } catch (apiErr) {
                if (!(apiErr instanceof RefusedError)) throw apiErr;
                throw new Error('agent');
            }
            const agent = await res.json();
            const config = { ...(agent?.config || {}) };
            const current = Array.isArray(config.knowledge_base_ids) ? config.knowledge_base_ids : [];
            if (current.includes(suggestion.kbId)) { loadOverviewExtras(); return; }
            config.knowledge_base_ids = [...current, suggestion.kbId];
            try {
                await apiRequest('PUT /agents/{id}', { params: { id: suggestion.agentId }, body: { config } });
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

    const [source, setSource] = useOpenSource(kbId, sourceId, () => go(kbId, tab, null));

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

    useCreateOnNewRoute(initialKbId, canManage, create);

    // The breadcrumb on the source screen names the knowledge base it sits
    // in. That name lives on the KB, not on the source row, so a hard
    // refresh straight onto a source has to ask for it.
    const kbName = useKbName(kbId);

    if (kbId && sourceId && source) {
        return <KbSourceScreen kbId={kbId} kbName={kbName} source={source} canManage={canManage} onBack={() => go(kbId, tab, null)} setSource={setSource} />;
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
