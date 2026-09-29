import { CalendarClock, Ellipsis, RefreshCw, Search, ShieldCheck, Zap } from 'lucide-react';
import React, { useMemo, useRef, useState } from 'react';
import { cronParams, refreshModeKey } from './freshness';
import { nOf } from './plural';
import ScheduleMenu from './ScheduleMenu';
import { sourceKind, sublineFor } from './sourceKinds';
import useRelativeTime from '../../../../hooks/useRelativeTime';
import useTranslation from '../../../../hooks/useTranslation';
import AnchoredMenu from '../../../shared/AnchoredMenu';
import { kindColorVar, kindTint } from '../../../shared/kindColors';

/**
 * The Bronnen tab: every source of a knowledge base, what it is, and how it
 * keeps itself current (Knowledge artboard 1a, `grid 1fr 150px 160px 32px`).
 *
 * ── EACH ROW SAYS WHAT IT IS, IN ITS OWN TERMS ──────────────────────
 * The artboard writes a different second line per kind — "map · 38
 * bestanden (pdf, docx)", "kolommen Artikel, Omschrijving, Prijs · 212
 * rijen", "geplakte tekst · door Tessa". That is the whole point of the
 * table: five rows reading "5 documenten" tell you nothing about which one
 * holds the thing you are looking for. `sourceKinds.sublineFor` owns those
 * sentences; this file only places them.
 *
 * ── NO CHUNKS, ANYWHERE ─────────────────────────────────────────────
 * "N chunks" and "Re-index" are gone from Studio on purpose (plan K2). They
 * are facts about the retrieval implementation, not about the person's
 * material, and putting them on screen made every knowledge base look like
 * a database to be tuned. The route that serves chunks stays for admin,
 * debug and mobile; the web UI simply stops asking.
 */
export default function SourcesTab({
    sources = [],
    totals = null,
    loading = false,
    error = null,
    canManage = false,
    onOpen,
    onRefresh,
    onRename,
    onDelete,
    onSchedule,
}) {
    const { t } = useTranslation();
    const rel = useRelativeTime();
    const [query, setQuery] = useState('');

    const shown = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return sources;
        return sources.filter(s => String(s.name || '').toLowerCase().includes(q));
    }, [sources, query]);

    const summary = totals ? [
        nOf(t, 'knowledge.n_sources', totals.sourceCount, '{count} source', '{count} sources'),
        nOf(t, 'knowledge.n_documents', totals.documentCount, '{count} document', '{count} documents'),
        nOf(t, 'knowledge.n_auto_refresh', totals.autoRefreshCount, '{count} refreshes automatically', '{count} refresh automatically'),
    ].join(' · ') : '';

    return (
        <div className="flex flex-col gap-3 min-h-0" data-testid="kb-tab-sources">
            <div className="flex items-center gap-2 text-[12px]">
                <label className="relative block shrink-0" style={{ width: 260 }}>
                    <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
                    <input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder={t('knowledge.sources.search', 'Search sources…')}
                        aria-label={t('knowledge.sources.search_label', 'Search this knowledge base’s sources')}
                        className="w-full pl-8 pr-2 py-1.5 rounded-lg text-xs border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1"
                        style={{ background: 'var(--bg-card)', borderColor: 'var(--border-default)', color: 'var(--text-primary)', outlineColor: 'var(--accent-primary)' }}
                    />
                </label>
                {summary && <span style={{ color: 'var(--text-tertiary)' }}>{summary}</span>}
            </div>

            <div
                className="overflow-hidden text-[12px]"
                style={{ borderRadius: 12, background: 'var(--bg-card)', border: '1px solid var(--border-default)', boxShadow: 'var(--shadow-sm)' }}
            >
                <div
                    className="grid gap-3 px-3.5 py-2 text-[10px] font-semibold uppercase"
                    style={{ gridTemplateColumns: '1fr 150px 160px 32px', letterSpacing: '.08em', color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border-default)' }}
                >
                    <span>{t('knowledge.sources.col_source', 'Source')}</span>
                    <span>{t('knowledge.sources.col_refresh', 'Refresh')}</span>
                    <span>{t('knowledge.sources.col_updated', 'Last updated')}</span>
                    <span />
                </div>

                {loading ? (
                    <p className="px-3.5 py-6 text-center" style={{ color: 'var(--text-tertiary)' }}>
                        {t('knowledge.loading', 'Loading…')}
                    </p>
                ) : error ? (
                    <p className="px-3.5 py-4" style={{ color: 'var(--warning)' }}>{error}</p>
                ) : sources.length === 0 ? (
                    <p className="px-3.5 py-6 text-center" style={{ color: 'var(--text-secondary)' }}>
                        {t('knowledge.sources.empty', 'No sources yet. Add one on the right — it keeps itself up to date from then on.')}
                    </p>
                ) : shown.length === 0 ? (
                    <p className="px-3.5 py-6 text-center" style={{ color: 'var(--text-secondary)' }}>
                        {t('knowledge.sources.search_empty', 'No source matches that.')}
                    </p>
                ) : shown.map((s, i) => (
                    <SourceRow
                        key={s.id}
                        t={t}
                        rel={rel}
                        source={s}
                        last={i === shown.length - 1}
                        canManage={canManage}
                        onOpen={() => onOpen?.(s)}
                        onRefresh={onRefresh}
                        onRename={onRename}
                        onDelete={onDelete}
                        onSchedule={onSchedule}
                    />
                ))}
            </div>

            <p
                className="flex items-center gap-2 px-3 py-2 rounded-lg"
                style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)', fontSize: 12 }}
            >
                <ShieldCheck className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                {t('knowledge.sources.privacy_note', 'Whoever may see this knowledge base also sees what the AI quotes from it. Sources containing personal data are marked by Privacy Shield automatically.')}
            </p>
        </div>
    );
}

function SourceRow({ t, rel, source, last, canManage, onOpen, onRefresh, onRename, onDelete, onSchedule }) {
    const [menuOpen, setMenuOpen] = useState(false);
    const [scheduleOpen, setScheduleOpen] = useState(false);
    const menuRef = useRef(null);
    const meta = sourceKind(source.kind);
    const Icon = meta.icon;
    const subline = sublineFor(source);
    // `fieldKeys` is a list of field ids a meeting source stores; it becomes a
    // readable list here rather than in sourceKinds, which has no translator.
    const sublineParams = subline.params?.fieldKeys
        ? { ...subline.params, fields: subline.params.fieldKeys.map(f => meetingFieldLabel(t, f)).join(', ') }
        : subline.params;
    // A source refreshing right now gets the builder's pulse outline (K3
    // drives the status); until then it simply never has that status.
    const refreshing = source.status === 'refreshing';

    return (
        <div
            className="grid gap-3 items-center px-3.5 py-2.5"
            style={{ gridTemplateColumns: '1fr 150px 160px 32px', borderBottom: last ? 'none' : '1px solid var(--border-default)' }}
            data-testid="kb-source-row"
            data-source-id={source.id}
            data-kind={source.kind}
            data-status={source.status || 'idle'}
        >
            <button
                type="button"
                onClick={onOpen}
                className="flex items-center gap-2.5 min-w-0 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 rounded"
                style={{ outlineColor: 'var(--accent-primary)' }}
            >
                <span
                    className="w-7 h-7 rounded-lg grid place-items-center shrink-0"
                    style={{
                        background: meta.tint ? kindTint(meta.tint, 16) : 'var(--bg-tertiary)',
                        color: meta.tint ? kindColorVar(meta.tint) : 'var(--text-secondary)',
                        // The canvas's own "this is running" outline (index.css
                        // @keyframes bf-node-pulse) rather than a spinner: it
                        // animates outline-color only, so a row that starts
                        // refreshing cannot shift the table under the cursor.
                        outline: refreshing ? '2px solid transparent' : 'none',
                        outlineOffset: 1,
                        animation: refreshing ? 'bf-node-pulse 1.6s ease-in-out infinite' : undefined,
                    }}
                    aria-hidden="true"
                >
                    <Icon className="w-3.5 h-3.5" />
                </span>
                <span className="min-w-0">
                    <span className="block font-medium truncate" style={{ color: 'var(--text-primary)' }}>{source.name}</span>
                    <span className="block truncate" style={{ color: 'var(--text-tertiary)' }}>
                        {t(subline.key, sublineFallback(subline.key), sublineParams)}
                    </span>
                </span>
            </button>

            <RefreshCell t={t} source={source} />

            <span style={{ color: 'var(--text-secondary)' }}>
                {source.refreshMode === 'live'
                    ? t('knowledge.sources.always_current', 'always current')
                    : (rel(source.lastRefreshAt) || t('knowledge.sources.never_refreshed', 'never'))}
            </span>

            <span className="justify-self-end">
                {canManage && (
                    <>
                        <button
                            ref={menuRef}
                            type="button"
                            onClick={() => setMenuOpen(v => !v)}
                            aria-haspopup="menu"
                            aria-expanded={menuOpen}
                            aria-label={t('knowledge.sources.row_menu', 'Actions for {name}', { name: source.name })}
                            className="p-1 rounded focus-visible:outline focus-visible:outline-2"
                            style={{ color: 'var(--text-tertiary)', outlineColor: 'var(--accent-primary)' }}
                        >
                            <Ellipsis className="w-3.5 h-3.5" aria-hidden="true" />
                        </button>
                        <AnchoredMenu open={menuOpen} onClose={() => setMenuOpen(false)} anchorRef={menuRef} align="right" width={200} role="menu"
                            className="py-1"
                            style={{ background: 'var(--bg-card)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                        >
                            <MenuItem onClick={() => { setMenuOpen(false); onRefresh?.(source); }}>
                                {t('knowledge.sources.refresh_now', 'Refresh now')}
                            </MenuItem>
                            <MenuItem onClick={() => { setMenuOpen(false); onRename?.(source); }}>
                                {t('knowledge.sources.rename', 'Rename')}
                            </MenuItem>
                            <MenuItem onClick={() => { setMenuOpen(false); setScheduleOpen(true); }}>
                                {t('knowledge.sources.schedule', 'Refresh schedule…')}
                            </MenuItem>
                            <MenuItem onClick={() => { setMenuOpen(false); onOpen?.(); }}>
                                {t('knowledge.sources.open', 'Open')}
                            </MenuItem>
                            <MenuItem destructive onClick={() => { setMenuOpen(false); onDelete?.(source); }}>
                                {t('knowledge.sources.delete', 'Delete')}
                            </MenuItem>
                        </AnchoredMenu>
                        {/* Anchored to the same ⋯ button: the schedule is a
                            property of this row, so it opens where the row is
                            rather than in a dialog over the table. */}
                        <ScheduleMenu
                            open={scheduleOpen}
                            onClose={() => setScheduleOpen(false)}
                            anchorRef={menuRef}
                            source={source}
                            onChange={(refresh) => onSchedule?.(source, refresh)}
                        />
                    </>
                )}
            </span>
        </div>
    );
}

/** The "Verversen" cell: an icon per mode, and plain text for manual. */
function RefreshCell({ t, source }) {
    const mode = source.refreshMode || 'manual';
    if (mode === 'manual') {
        return <span style={{ color: 'var(--text-tertiary)' }}>{t('knowledge.refresh.manual', 'manual')}</span>;
    }
    const Icon = mode === 'live' ? Zap : (mode === 'schedule' ? CalendarClock : RefreshCw);
    const key = refreshModeKey(mode);
    const params = mode === 'schedule' ? cronParams(source) : {};
    return (
        <span className="inline-flex items-center gap-1.5" style={{ color: 'var(--text-secondary)' }}>
            <Icon className="w-3 h-3 shrink-0" aria-hidden="true" />
            {t(key, refreshFallback(key), params)}
        </span>
    );
}

function MenuItem({ children, onClick, destructive = false }) {
    return (
        <button
            type="button"
            role="menuitem"
            onClick={onClick}
            className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--bg-secondary)]"
            style={{ color: destructive ? 'var(--error)' : 'var(--text-primary)' }}
        >
            {children}
        </button>
    );
}

function refreshFallback(key) {
    switch (key) {
        case 'knowledge.refresh.live': return 'live';
        case 'knowledge.refresh.on_change': return 'on change';
        case 'knowledge.refresh.after_meeting': return 'after every meeting';
        case 'knowledge.refresh.schedule': return 'on a schedule';
        default: return 'manual';
    }
}

/**
/** A meeting source's field ids, as a person reads them. */
function meetingFieldLabel(t, field) {
    switch (field) {
        case 'summary': return t('knowledge.meeting.field_summary', 'Summary').toLowerCase();
        case 'decisions': return t('knowledge.meeting.field_decisions', 'Decisions').toLowerCase();
        case 'questions': return t('knowledge.meeting.field_questions', 'Open questions').toLowerCase();
        case 'actions': return t('knowledge.meeting.field_actions', 'Actions').toLowerCase();
        default: return field;
    }
}

/**
 * English of last resort for the subline keys `sourceKinds.sublineFor`
 * returns. They are reached through a variable, so a literal scan never sees
 * them; this map is what keeps a missing catalogue entry from rendering a
 * raw key in the middle of the table.
 */
const SUBLINE_EN = Object.freeze({
    'knowledge.subline.folder': 'folder · {count} file',
    'knowledge.subline.folder_plural': 'folder · {count} files',
    'knowledge.subline.upload': 'uploaded · {count} file',
    'knowledge.subline.upload_plural': 'uploaded · {count} files',
    'knowledge.subline.datatable': 'table {table} · {count} row',
    'knowledge.subline.datatable_plural': 'table {table} · {count} rows',
    'knowledge.subline.datatable_columns': 'columns {columns} · {count} row',
    'knowledge.subline.datatable_columns_plural': 'columns {columns} · {count} rows',
    'knowledge.subline.meeting': '{fields} · {count} meeting',
    'knowledge.subline.meeting_plural': '{fields} · {count} meetings',
    'knowledge.subline.webpage': 'web page · {count} page',
    'knowledge.subline.webpage_plural': 'web page · {count} pages',
    'knowledge.subline.webpage_site': 'whole site · {count} page',
    'knowledge.subline.webpage_site_plural': 'whole site · {count} pages',
    'knowledge.subline.text': 'pasted text · by {by}',
    'knowledge.subline.automation': 'filled by an automation · {count} document',
    'knowledge.subline.automation_plural': 'filled by an automation · {count} documents',
    'knowledge.subline.legacy': 'imported · {count} document',
    'knowledge.subline.legacy_plural': 'imported · {count} documents',
});

function sublineFallback(key) {
    return SUBLINE_EN[key] || SUBLINE_EN['knowledge.subline.legacy_plural'];
}
