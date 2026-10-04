// The version history of one notebook or document, as a drawer on the right:
// the versions per day on the left, the selected one on the right with what
// it changed and what can be done with it.
//
//   <VersionHistoryPanel baseUrl="/api/notebooks/<id>" canEdit onRestored={…} onClose={…} />
//
// Shared by notebooks, pages and designed documents: both item kinds speak
// the same versions contract (api/queries/versions.ts). `renderContent` lets
// a host that has its own renderer (a designed document in its frame) offer
// "Show as it looked" next to the text comparison.
//
// It never interrupts: no modal except the restore confirmation, no toasts; a
// failure is said in place. Escape closes it (unless a field inside has
// focus and uses Escape itself).

import { Bookmark, History, X } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useProjectMembersQuery } from '../../api/queries/projects';
import {
    CURRENT, isVersionGone, peopleOfPages, useNameCurrentVersion, useVersionQuery, useVersionsQuery,
    type VersionContent, type VersionDetail as VersionDetailData, type VersionMeta, type VersionPeople,
} from '../../api/queries/versions';
import useTranslation from '../../hooks/useTranslation';
import { managedOf } from '../shared/managedPart';
import NameVersionForm from './NameVersionForm';
import VersionCompare from './VersionCompare';
import VersionDetail from './VersionDetail';
import VersionList from './VersionList';
import { versionErrorText, type PeopleNames } from './versionText';

export interface VersionHistoryPanelProps {
    /** `/api/notebooks/<id>` or `/api/studio-documents/<id>`. */
    baseUrl: string;
    /** Editors (and owners) may name and restore; everybody else reads. */
    canEdit: boolean;
    /** The restore went through; `current` is the item as the server now holds it. */
    onRestored?: (current: unknown) => void;
    onClose: () => void;
    /** A preview of a version as it looked, for hosts with their own renderer. */
    renderContent?: (content: VersionContent, version: VersionDetailData) => React.ReactNode;
    /** Names contributors after the project's members. */
    projectId?: string | null;
    /** Names the host already has, merged over the members' names. */
    people?: PeopleNames;
    currentUserId?: string | null;
    /** The optimistic-concurrency token the host holds, sent with a restore. */
    expectedVersion?: number | string | null;
    /**
     * Open straight on a version, e.g. "what changed since I last looked":
     * `from` selected and compared with `to` (a version id or 'current'), or
     * with the version before it when `to` is left out. `at` is when `from`
     * was the state looked at: should `from` no longer be kept, the newest
     * listed version from then or before stands in for it.
     */
    initialCompare?: { from: string; to?: string; at?: string | null } | null;
    title?: string;
    /**
     * The `managed` of the item's GET (managedPart.managedOf): a part a Solution
     * stage manages. Its history can be read and compared, but not restored or
     * named: only a deploy changes it, so Restore and "Name this version" go.
     */
    managed?: unknown;
}

/**
 * Who is who: the names the versions answer carried (every contributor, as
 * the server named them for the reader's organisation), under the project's
 * members and the host's own names. Only an id nobody named reads "Former
 * member".
 */
function useNames(projectId: string | null | undefined, extra: PeopleNames | undefined, fromServer: VersionPeople): PeopleNames {
    const members = useProjectMembersQuery(projectId || null);
    return useMemo(() => ({ ...fromServer, ...(members.data?.people || {}), ...(extra || {}) }), [fromServer, members.data, extra]);
}

function ListBody({ list, versions, selectedId, onSelect, people, currentUserId }: {
    list: ReturnType<typeof useVersionsQuery>;
    versions: VersionMeta[];
    selectedId: string | null;
    onSelect: (v: VersionMeta) => void;
    people: PeopleNames;
    currentUserId?: string | null;
}) {
    const { t } = useTranslation();
    if (list.isPending) return <p role="status" className="m-0 py-8 text-center text-[12.5px] text-[var(--text-tertiary)]">{t('versions.loading', 'Loading the history…')}</p>;
    if (list.isError) {
        return (
            <div role="alert" className="space-y-2 px-2.5 py-2" data-testid="versions-failed">
                <p className="m-0 text-[12.5px] text-[var(--error-ink)]">{versionErrorText(t, list.error, t('versions.load_failed', 'Could not load the history.'))}</p>
                <button type="button" onClick={() => list.refetch()} className="text-[12px] underline text-[var(--text-secondary)]">{t('versions.retry', 'Try again')}</button>
            </div>
        );
    }
    if (!versions.length) {
        return (
            <p className="m-0 px-2.5 py-3 rounded-lg text-[12.5px] text-[var(--text-tertiary)] bg-[var(--bg-secondary)]" data-testid="versions-empty">
                {t('versions.empty', 'No versions yet. A version is kept after each pause in editing, before and after every AI edit, and whenever somebody names one.')}
            </p>
        );
    }
    return (
        <VersionList
            versions={versions}
            selectedId={selectedId}
            onSelect={onSelect}
            people={people}
            currentUserId={currentUserId}
            hasMore={list.hasNextPage}
            loadingMore={list.isFetchingNextPage}
            onLoadMore={() => list.fetchNextPage()}
        />
    );
}

/** "Name this version": the current content gets a name and is kept for good. */
function NameCurrent({ baseUrl, onNamed, onCancel }: { baseUrl: string; onNamed: (v: VersionMeta) => void; onCancel: () => void }) {
    const { t } = useTranslation();
    const nameCurrent = useNameCurrentVersion(baseUrl);
    return (
        <div className="px-4 py-3 border-b border-[var(--border-subtle)]">
            <p className="m-0 mb-2 text-[12px] text-[var(--text-tertiary)]">{t('versions.name_current_hint', 'Gives the content as it is now a name, so it is easy to find and is kept for good.')}</p>
            <NameVersionForm
                busy={nameCurrent.isPending}
                error={nameCurrent.error ? versionErrorText(t, nameCurrent.error) : null}
                onCancel={onCancel}
                onSubmit={(name) => { if (name) nameCurrent.mutate(name, { onSuccess: onNamed }); }}
            />
        </div>
    );
}

function PanelHeader({ title, canName, onName, onClose, headingRef }: {
    title?: string;
    canName: boolean;
    onName: () => void;
    onClose: () => void;
    headingRef: React.RefObject<HTMLHeadingElement | null>;
}) {
    const { t } = useTranslation();
    return (
        <header className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border-subtle)]">
            <History className="w-4 h-4 text-[var(--text-secondary)]" aria-hidden="true" />
            <h2 id="version-history-title" ref={headingRef} tabIndex={-1} className="m-0 flex-1 min-w-0 truncate text-[14px] font-semibold text-[var(--text-primary)] outline-none">
                {title || t('versions.title', 'Version history')}
            </h2>
            {canName && (
                <button
                    type="button"
                    onClick={onName}
                    className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-[12.5px] border border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                    data-testid="version-name-current"
                >
                    <Bookmark className="w-3.5 h-3.5" aria-hidden="true" />
                    {t('versions.name_current', 'Name this version')}
                </button>
            )}
            <button type="button" onClick={onClose} aria-label={t('versions.close', 'Close the history')} className="p-1.5 rounded-lg text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)]" data-testid="version-history-close">
                <X className="w-4 h-4" aria-hidden="true" />
            </button>
        </header>
    );
}

/** Focus the heading on open; Escape closes (a field that handles Escape itself stops it first). */
function useDrawerKeys(onClose: () => void) {
    const heading = useRef<HTMLHeadingElement>(null);
    useEffect(() => { heading.current?.focus(); }, []);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);
    return heading;
}

/** The newest listed version from `at` or before (the list is newest first), or null. */
function newestAtOrBefore(versions: VersionMeta[], at: string | null | undefined): VersionMeta | null {
    const limit = at ? Date.parse(at) : Number.NaN;
    if (!Number.isFinite(limit)) return null;
    return versions.find((v) => Date.parse(v.createdAt) <= limit) || null;
}

/**
 * Whether the version asked to open on is no longer kept (the same query the
 * comparison reads, so no second request), and if so what stands in for it:
 * the state of the moment it was looked at, the newest listed version from
 * then or before.
 */
function useStandIn(baseUrl: string, unlisted: string | null, versions: VersionMeta[], at: string | null | undefined) {
    const gone = isVersionGone(useVersionQuery(baseUrl, unlisted).error);
    return { gone, standIn: gone ? newestAtOrBefore(versions, at) : null };
}

type Gone = 'stand_in' | 'none' | null;

/**
 * Which version is open and what it is compared with; opening on a comparison
 * when asked. `gone` says the version asked for is no longer kept, and whether
 * another stands in for it.
 */
function useSelection(baseUrl: string, initialCompare: VersionHistoryPanelProps['initialCompare'], versions: VersionMeta[], listPending: boolean) {
    const startAt = initialCompare?.from && initialCompare.from !== CURRENT ? initialCompare.from : null;
    const [selectedId, setSelectedId] = useState<string | null>(startAt);
    const [compareWith, setCompareWith] = useState<string | null>(initialCompare?.to || null);
    const listed = versions.find((v) => v.id === selectedId) || null;
    // Asked to open on a version the loaded pages do not hold (an older one,
    // or one folded into a later save): compare it with the target directly,
    // unless it is no longer kept.
    const unlisted = startAt !== null && selectedId === startAt && !listed && !listPending ? startAt : null;
    const { gone, standIn } = useStandIn(baseUrl, unlisted, versions, initialCompare?.at);
    const select = (v: VersionMeta | null) => { setSelectedId(v ? v.id : null); setCompareWith(null); };
    const common = { compareWith, setCompareWith, select };
    if (!gone) return { ...common, selectedId, selected: listed, orphan: unlisted, gone: null as Gone };
    return { ...common, selectedId: standIn ? standIn.id : null, selected: standIn, orphan: null, gone: (standIn ? 'stand_in' : 'none') as Gone };
}

function GoneNotice({ gone }: { gone: Exclude<Gone, null> }) {
    const { t } = useTranslation();
    return (
        <p role="status" className="m-0 px-4 py-1.5 text-[12px] text-[var(--text-secondary)] border-b border-[var(--border-subtle)]" data-testid="version-gone">
            {gone === 'stand_in'
                ? t('versions.gone_stand_in', 'That version is no longer kept, so this compares from the closest earlier one.')
                : t('versions.gone_pick', 'That version is no longer kept. Pick a version to compare with.')}
        </p>
    );
}

const WIDE = 'min-[900px]:w-[min(980px,100vw)]';
const NARROW = 'min-[480px]:w-[400px]';
const LIST_BESIDE = 'w-[340px] flex-shrink-0 border-r border-[var(--border-subtle)] max-[900px]:hidden';

function HistoryPanel({
    baseUrl, canEdit, onRestored, onClose, renderContent, projectId, people: extraPeople, currentUserId, expectedVersion, initialCompare, title, locked = false,
}: VersionHistoryPanelProps & { locked?: boolean }) {
    const { t } = useTranslation();
    const list = useVersionsQuery(baseUrl);
    const serverPeople = useMemo(() => peopleOfPages(list.data?.pages), [list.data]);
    const people = useNames(projectId, extraPeople, serverPeople);
    const versions = useMemo(() => (list.data?.pages || []).flatMap((p) => p.versions), [list.data]);
    const { selectedId, selected, compareWith, setCompareWith, select, orphan, gone } = useSelection(baseUrl, initialCompare, versions, list.isPending);
    const [naming, setNaming] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    const heading = useDrawerKeys(onClose);

    const restored = (current: unknown) => {
        select(null);
        setNotice(t('versions.restored_notice', 'Restored. The content it replaced is kept as a version.'));
        onRestored?.(current);
    };
    const named = (v: VersionMeta) => {
        setNaming(false);
        select(v);
        setNotice(t('versions.named_notice', 'Version named.'));
    };

    return (
        <aside
            aria-labelledby="version-history-title"
            className={`fixed top-0 right-0 bottom-0 z-40 flex flex-col bg-[var(--bg-card)] border-l border-[var(--border-subtle)] shadow-xl w-full ${selectedId ? WIDE : NARROW}`}
            data-testid="version-history-panel"
        >
            <PanelHeader title={title} canName={canEdit && !naming} onName={() => { setNaming(true); setNotice(null); }} onClose={onClose} headingRef={heading} />
            {naming && (
                <NameCurrent
                    baseUrl={baseUrl}
                    onCancel={() => setNaming(false)}
                    onNamed={named}
                />
            )}
            {locked && <p role="note" className="m-0 px-4 py-1.5 text-[12px] text-[var(--text-secondary)] border-b border-[var(--border-subtle)]" data-testid="version-managed">{t('managed_part.read_only_hint', 'Read-only: this part is managed by a Solution stage.')}</p>}
            {notice && <p role="status" className="m-0 px-4 py-1.5 text-[12px] text-[var(--success-ink)] border-b border-[var(--border-subtle)]" data-testid="version-notice">{notice}</p>}
            {gone && !notice && <GoneNotice gone={gone} />}
            <div className="flex-1 min-h-0 flex">
                <div className={`min-h-0 overflow-y-auto custom-scrollbar px-2 py-3 ${selectedId ? LIST_BESIDE : 'flex-1'}`}>
                    <ListBody list={list} versions={versions} selectedId={selectedId} onSelect={(v) => { select(v); setNotice(null); }} people={people} currentUserId={currentUserId} />
                </div>
                {selected && (
                    <div className="flex-1 min-w-0 min-h-0">
                        <VersionDetail
                            // Another version is another detail: an open
                            // rename form never carries over to it.
                            key={selected.id}
                            baseUrl={baseUrl}
                            version={selected}
                            versions={versions}
                            compareWith={compareWith}
                            onCompareWith={setCompareWith}
                            canEdit={canEdit}
                            people={people}
                            currentUserId={currentUserId}
                            expectedVersion={expectedVersion}
                            renderContent={renderContent}
                            onBack={() => select(null)}
                            onRestored={restored}
                        />
                    </div>
                )}
                {orphan && (
                    <div className="flex-1 min-w-0 min-h-0 overflow-y-auto custom-scrollbar px-4 py-3">
                        <VersionCompare baseUrl={baseUrl} fromRef={orphan} toRef={compareWith || CURRENT} />
                    </div>
                )}
            </div>
        </aside>
    );
}

export default function VersionHistoryPanel(props: VersionHistoryPanelProps) {
    // Another item, or another version to open on, is another history: its
    // own selection, forms and notices, never those of the one before.
    const open = props.initialCompare;
    // Managed: read and compare, never restore or name (only a deploy changes the part).
    const locked = managedOf({ managed: props.managed }) !== null;
    return <HistoryPanel key={`${props.baseUrl}|${open?.from ?? ''}|${open?.to ?? ''}`} {...props} canEdit={props.canEdit && !locked} locked={locked} />;
}
