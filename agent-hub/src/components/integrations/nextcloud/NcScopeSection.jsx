import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, ChevronDown, Search, Loader2, Folder, FolderOpen } from 'lucide-react';
import { API_BASE, authFetch } from '../../../utils/helpers';
import { useTranslation } from '../../../hooks/useTranslation';
import SegmentedControl from '../../shared/SegmentedControl';

/**
 * "What Bee Flow may access" — the per-user Nextcloud scope.
 *
 * Lives inside the Nextcloud IntegrationRow's expanded body, so it costs
 * zero pixels until someone opens the row. One quiet bordered container of
 * catalog rows; each row states its scope IN WORDS ("Everything", "3
 * calendars", "Off") with a small warning-dot when narrowed — the collapsed
 * control must still say what's on (the chat-composer lesson). Clicking a
 * row discloses an inline panel (the settings-page pattern —
 * MeetingNotesSection), with the KB-picker chrome inside: segmented mode
 * choice, then search + checkbox list (or a lazy folder tree for Files)
 * only when "Only selected" is active.
 *
 * Every change saves immediately through PUT /api/nc-scope — the server
 * sanitises, audits, and enforces in the tool dispatcher; this component
 * is presentation, never authorization.
 */

const MODE_ALL = 'all';
const MODE_SELECTED = 'selected';
const MODE_OFF = 'off';

const PANEL_ANIM = 'modelTierPanelIn 140ms cubic-bezier(0.22, 1, 0.36, 1) both';

function scopeWords(t, entry) {
    if (!entry || entry.mode === MODE_ALL) return t('nc_scope.everything', 'Everything');
    if (entry.mode === MODE_OFF) return t('nc_scope.off', 'Off');
    const n = (entry.selected || []).length;
    const label = entry.resource?.label || t('nc_scope.items', 'items');
    if (n === 0) return t('nc_scope.none_selected', 'Nothing selected');
    return `${n} ${label}`;
}

// ── Folder tree (lazy, one PROPFIND level per expansion) ────────────────────

const FolderNode = ({ path, label, depth, selected, onToggle, t }) => {
    const [expanded, setExpanded] = useState(false);
    const [children, setChildren] = useState(null); // null = not fetched
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const checked = selected.includes(path);
    // An ancestor selection already covers this folder — show it as
    // implicitly on, so the tree reads like the enforcement behaves.
    const covered = !checked && selected.some(sel => sel === '/' || path === sel || path.startsWith(sel + '/'));

    const expand = async () => {
        const next = !expanded;
        setExpanded(next);
        if (next && children === null && !loading) {
            setLoading(true);
            setError(null);
            try {
                const res = await authFetch(`${API_BASE}/api/nc-scope/resources/nextcloud?path=${encodeURIComponent(path)}`);
                const data = await res.json().catch(() => ({}));
                if (res.ok) setChildren(data.resources || []);
                else setError(data.error || t('nc_scope.tree_error', 'Could not load folders'));
            } catch (_) {
                setError(t('nc_scope.tree_error', 'Could not load folders'));
            }
            setLoading(false);
        }
    };

    return (
        <div>
            <div
                className="flex items-center gap-1.5 py-1 rounded"
                style={{ paddingLeft: `${depth * 20}px` }}
                data-testid={`nc-scope-folder-${path}`}
            >
                <button
                    type="button"
                    onClick={expand}
                    aria-expanded={expanded}
                    aria-label={expanded ? t('nc_scope.collapse', 'Collapse') : t('nc_scope.expand', 'Expand')}
                    className="p-0.5 rounded flex-shrink-0"
                    style={{ color: 'var(--text-tertiary)' }}
                >
                    {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                </button>
                <label className="flex items-center gap-2 min-w-0 cursor-pointer flex-1">
                    <input
                        type="checkbox"
                        className="w-4 h-4 accent-[var(--accent-primary)] flex-shrink-0"
                        checked={checked}
                        ref={el => { if (el) el.indeterminate = !checked && covered; }}
                        onChange={() => onToggle(path)}
                    />
                    {expanded
                        ? <FolderOpen size={14} style={{ color: 'var(--text-tertiary)' }} className="flex-shrink-0" />
                        : <Folder size={14} style={{ color: 'var(--text-tertiary)' }} className="flex-shrink-0" />}
                    <span className="text-[13px] truncate" style={{ color: 'var(--text-primary)' }}>{label}</span>
                </label>
            </div>
            {expanded && (
                <div>
                    {loading && (
                        <p className="text-[11px] italic py-1" style={{ paddingLeft: `${(depth + 1) * 20}px`, color: 'var(--text-tertiary)' }}>
                            {t('nc_scope.loading', 'Loading…')}
                        </p>
                    )}
                    {error && (
                        <p className="text-[11px] italic py-1" style={{ paddingLeft: `${(depth + 1) * 20}px`, color: 'var(--text-tertiary)' }}>{error}</p>
                    )}
                    {children && children.length === 0 && !loading && (
                        <p className="text-[11px] italic py-1" style={{ paddingLeft: `${(depth + 1) * 20}px`, color: 'var(--text-tertiary)' }}>
                            {t('nc_scope.no_subfolders', 'No subfolders')}
                        </p>
                    )}
                    {(children || []).map(c => (
                        <FolderNode key={c.id} path={c.id} label={c.label} depth={depth + 1} selected={selected} onToggle={onToggle} t={t} />
                    ))}
                </div>
            )}
        </div>
    );
};

const FolderTreePicker = ({ selected, onToggle, t }) => (
    <div className="max-h-72 overflow-auto rounded-lg p-1.5" style={{ border: '1px solid var(--border-subtle)', background: 'var(--bg-primary)' }} data-testid="nc-scope-folder-tree">
        <FolderNode path="/" label={t('nc_scope.all_files_root', 'All files')} depth={0} selected={selected} onToggle={onToggle} t={t} />
    </div>
);

// ── Flat resource picker (calendars, boards, rooms, …) ──────────────────────

const ResourcePicker = ({ integrationId, resourceLabel, selected, onToggle, t }) => {
    const [resources, setResources] = useState(null);
    const [error, setError] = useState(null);
    const [query, setQuery] = useState('');

    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const res = await authFetch(`${API_BASE}/api/nc-scope/resources/${integrationId}`);
                const data = await res.json().catch(() => ({}));
                if (!alive) return;
                if (res.ok) setResources(data.resources || []);
                else setError(data.error || t('nc_scope.list_error', 'Could not list resources'));
            } catch (_) {
                if (alive) setError(t('nc_scope.list_error', 'Could not list resources'));
            }
        })();
        return () => { alive = false; };
    }, [integrationId]);

    if (error) return <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{error}</p>;
    if (resources === null) {
        return (
            <p className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                <Loader2 size={12} className="animate-spin" /> {t('nc_scope.loading', 'Loading…')}
            </p>
        );
    }

    const q = query.trim().toLowerCase();
    const visible = q ? resources.filter(r => r.label.toLowerCase().includes(q)) : resources;
    // Selections whose resource no longer exists (deleted calendar, left
    // room) still bind server-side — show them so they can be unticked.
    const orphaned = selected.filter(id => !resources.some(r => r.id === id));

    return (
        <div data-testid={`nc-scope-picker-${integrationId}`}>
            {resources.length > 8 && (
                <div className="flex items-center gap-2 px-3 py-1.5 mb-2 rounded-lg" style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)' }}>
                    <Search size={13} style={{ color: 'var(--text-tertiary)' }} />
                    <input
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        placeholder={t('nc_scope.search', 'Search…')}
                        aria-label={t('nc_scope.search', 'Search…')}
                        className="flex-1 bg-transparent outline-none text-[13px]"
                        style={{ color: 'var(--text-primary)' }}
                    />
                </div>
            )}
            <div className="max-h-72 overflow-auto space-y-0.5">
                {visible.length === 0 && (
                    <p className="text-[11px] italic py-1" style={{ color: 'var(--text-tertiary)' }}>
                        {t('nc_scope.no_matches', 'Nothing found')}
                    </p>
                )}
                {visible.map(r => {
                    const checked = selected.includes(r.id);
                    return (
                        <label
                            key={r.id}
                            className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg cursor-pointer"
                            style={{ background: checked ? 'color-mix(in srgb, var(--accent-primary) 8%, transparent)' : 'transparent' }}
                            data-testid={`nc-scope-resource-${r.id}`}
                        >
                            <input
                                type="checkbox"
                                className="w-4 h-4 accent-[var(--accent-primary)] flex-shrink-0"
                                checked={checked}
                                onChange={() => onToggle(r.id)}
                            />
                            {r.color && <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: r.color }} aria-hidden="true" />}
                            <span className="text-[13px] truncate" style={{ color: 'var(--text-primary)' }}>{r.label}</span>
                        </label>
                    );
                })}
                {orphaned.map(id => (
                    <label key={id} className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg cursor-pointer" data-testid={`nc-scope-resource-${id}`}>
                        <input type="checkbox" className="w-4 h-4 accent-[var(--accent-primary)] flex-shrink-0" checked onChange={() => onToggle(id)} />
                        <span className="text-[13px] italic truncate" style={{ color: 'var(--text-muted)' }}>
                            {id} · {t('nc_scope.orphaned', 'no longer found')}
                        </span>
                    </label>
                ))}
            </div>
            <p className="text-[11px] mt-2" style={{ color: 'var(--text-tertiary)' }}>
                {selected.length === 0
                    ? t('nc_scope.none_hint', 'Nothing selected yet — Bee Flow can reach none of your {items} until you tick some.')
                        .replace('{items}', resourceLabel)
                    : null}
            </p>
        </div>
    );
};

// ── One catalog row + its disclosure panel ──────────────────────────────────

const ScopeRow = ({ id, entry, last, onModeChange, onSelectionSave, t }) => {
    const [open, setOpen] = useState(false);
    // Selection edits buffer locally; Done persists. Mode changes persist
    // immediately — flipping to Off must not wait behind a picker.
    const [draft, setDraft] = useState(entry.selected || []);
    useEffect(() => { setDraft(entry.selected || []); }, [entry.selected]);

    const narrowed = entry.mode !== MODE_ALL;
    const dirty = JSON.stringify(draft) !== JSON.stringify(entry.selected || []);

    const toggleDraft = (rid) => {
        setDraft(d => (d.includes(rid) ? d.filter(x => x !== rid) : [...d, rid]));
    };

    return (
        <div style={{ borderBottom: last ? 'none' : '1px solid var(--border-subtle)' }}>
            <button
                type="button"
                className="w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors"
                style={{ background: 'var(--bg-secondary)' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-tertiary)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-secondary)'; }}
                onClick={() => setOpen(v => !v)}
                aria-expanded={open}
                data-testid={`nc-scope-row-${id}`}
            >
                <span className="flex-1 min-w-0 text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                    {entry.name}
                </span>
                {narrowed && (
                    <span
                        className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                        style={{ background: 'var(--warning)' }}
                        aria-hidden="true"
                        data-testid={`nc-scope-dot-${id}`}
                    />
                )}
                <span className="text-[13px] flex-shrink-0" style={{ color: 'var(--text-secondary)' }} data-testid={`nc-scope-words-${id}`}>
                    {scopeWords(t, entry)}
                </span>
                <ChevronRight
                    size={13}
                    className="transition-transform flex-shrink-0"
                    style={{ color: 'var(--text-muted)', transform: open ? 'rotate(90deg)' : 'none' }}
                />
            </button>

            {open && (
                <div
                    className="px-4 pb-3 pt-2 space-y-3"
                    style={{ background: 'var(--bg-secondary)', borderTop: '1px solid var(--border-subtle)', animation: PANEL_ANIM }}
                >
                    <SegmentedControl
                        size="sm"
                        fullWidth
                        ariaLabel={t('nc_scope.mode_for', 'Access mode for {name}').replace('{name}', entry.name)}
                        value={entry.mode}
                        onChange={(mode) => onModeChange(id, mode)}
                        options={[
                            { value: MODE_ALL, label: t('nc_scope.mode_all', 'Everything') },
                            ...(entry.scopable ? [{ value: MODE_SELECTED, label: t('nc_scope.mode_selected', 'Only selected') }] : []),
                            { value: MODE_OFF, label: t('nc_scope.mode_off', 'Off') },
                        ]}
                    />
                    {entry.mode === MODE_SELECTED && (
                        <>
                            {id === 'nextcloud'
                                ? <FolderTreePicker selected={draft} onToggle={toggleDraft} t={t} />
                                : <ResourcePicker integrationId={id} resourceLabel={entry.resource?.label || ''} selected={draft} onToggle={toggleDraft} t={t} />}
                            <div className="flex items-center justify-between pt-1" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                                <button
                                    type="button"
                                    disabled={draft.length === 0}
                                    onClick={() => setDraft([])}
                                    className="text-[12px] disabled:opacity-40"
                                    style={{ color: 'var(--text-muted)' }}
                                    data-testid={`nc-scope-clear-${id}`}
                                >
                                    {t('nc_scope.clear', 'Clear')}
                                </button>
                                <button
                                    type="button"
                                    disabled={!dirty}
                                    onClick={() => onSelectionSave(id, draft)}
                                    className="px-4 py-1.5 rounded-lg text-[13px] font-medium disabled:opacity-40"
                                    style={{ background: 'var(--accent-primary)', color: 'var(--accent-primary-fg, #fff)' }}
                                    data-testid={`nc-scope-done-${id}`}
                                >
                                    {t('nc_scope.done', 'Done')}
                                </button>
                            </div>
                        </>
                    )}
                </div>
            )}
        </div>
    );
};

// ── The section ─────────────────────────────────────────────────────────────

const NcScopeSection = () => {
    const { t } = useTranslation();
    const [integrations, setIntegrations] = useState(null); // { [id]: {name, mode, selected, scopable, resource} }
    const [loadError, setLoadError] = useState(null);
    const [saveState, setSaveState] = useState('idle');     // idle | saving | saved | error
    const [confirmRevoke, setConfirmRevoke] = useState(false);
    const savedTimer = useRef(null);

    const load = useCallback(async () => {
        try {
            const res = await authFetch(`${API_BASE}/api/nc-scope`);
            const data = await res.json().catch(() => ({}));
            if (res.ok) { setIntegrations(data.integrations); setLoadError(null); }
            else setLoadError(data.error || t('nc_scope.load_error', 'Could not load access settings'));
        } catch (_) {
            setLoadError(t('nc_scope.load_error', 'Could not load access settings'));
        }
    }, [t]);
    useEffect(() => { load(); }, [load]);

    const persist = useCallback(async (body) => {
        setSaveState('saving');
        try {
            const res = await authFetch(`${API_BASE}/api/nc-scope`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                setIntegrations(data.integrations);
                setSaveState('saved');
                clearTimeout(savedTimer.current);
                savedTimer.current = setTimeout(() => setSaveState('idle'), 2000);
            } else {
                setSaveState('error');
            }
        } catch (_) {
            setSaveState('error');
        }
    }, []);

    const onModeChange = (id, mode) => {
        // Optimistic words update; the PUT response is authoritative.
        setIntegrations(cur => ({ ...cur, [id]: { ...cur[id], mode } }));
        persist({ integrations: { [id]: mode === MODE_SELECTED ? { mode, selected: integrations?.[id]?.selected || [] } : { mode } } });
    };

    const onSelectionSave = (id, selected) => {
        persist({ integrations: { [id]: { mode: MODE_SELECTED, selected } } });
    };

    const revokeAll = async () => {
        setConfirmRevoke(false);
        setSaveState('saving');
        try {
            const res = await authFetch(`${API_BASE}/api/nc-scope/revoke-all`, { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (res.ok) { setIntegrations(data.integrations); setSaveState('saved'); }
            else setSaveState('error');
        } catch (_) { setSaveState('error'); }
    };

    const reset = async () => {
        setSaveState('saving');
        try {
            const res = await authFetch(`${API_BASE}/api/nc-scope/reset`, { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (res.ok) { setIntegrations(data.integrations); setSaveState('saved'); }
            else setSaveState('error');
        } catch (_) { setSaveState('error'); }
    };

    if (loadError) return <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{loadError}</p>;
    if (!integrations) {
        return (
            <p className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--text-tertiary)' }} data-testid="nc-scope-loading">
                <Loader2 size={12} className="animate-spin" /> {t('nc_scope.loading', 'Loading…')}
            </p>
        );
    }

    const anyNarrowed = Object.values(integrations).some(e => e.mode !== MODE_ALL);
    const allOff = Object.values(integrations).every(e => e.mode === MODE_OFF);

    return (
        <div data-testid="nc-scope-section">
            <div className="flex items-baseline justify-between mb-2">
                <p className="text-[11px] font-semibold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>
                    {t('nc_scope.title', 'What Bee Flow may access')}
                </p>
                <span className="text-[11px]" style={{ color: saveState === 'error' ? 'var(--text-primary)' : 'var(--text-tertiary)' }} data-testid="nc-scope-savestate">
                    {saveState === 'saving' ? t('nc_scope.saving', 'Saving…')
                        : saveState === 'saved' ? t('nc_scope.saved', '✓ Saved')
                        : saveState === 'error' ? t('nc_scope.save_error', '⚠ Not saved — try again')
                        : ''}
                </span>
            </div>
            <p className="text-[12px] mb-3" style={{ color: 'var(--text-muted)' }}>
                {t('nc_scope.intro', 'Share parts of your Nextcloud with Bee Flow the way you would with a colleague — and take them back any time. Enforced on the server for chats, automations and apps alike.')}
            </p>
            <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border-subtle)' }}>
                {Object.entries(integrations).map(([id, entry], i, arr) => (
                    <ScopeRow
                        key={id}
                        id={id}
                        entry={entry}
                        last={i === arr.length - 1}
                        onModeChange={onModeChange}
                        onSelectionSave={onSelectionSave}
                        t={t}
                    />
                ))}
            </div>
            <div className="flex items-center justify-between mt-3">
                <button
                    type="button"
                    onClick={anyNarrowed ? reset : undefined}
                    disabled={!anyNarrowed}
                    className="text-[12px] disabled:opacity-40"
                    style={{ color: 'var(--text-muted)' }}
                    data-testid="nc-scope-reset"
                >
                    {t('nc_scope.reset', 'Reset to default')}
                </button>
                {confirmRevoke ? (
                    <span className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-primary)' }}>
                        {t('nc_scope.revoke_confirm', 'Turn off all Nextcloud access?')}
                        <button type="button" onClick={revokeAll} className="font-medium" style={{ color: 'var(--text-primary)' }} data-testid="nc-scope-revoke-yes">
                            {t('nc_scope.revoke_yes', 'Yes, revoke')}
                        </button>
                        <button type="button" onClick={() => setConfirmRevoke(false)} style={{ color: 'var(--text-muted)' }}>
                            {t('nc_scope.revoke_no', 'Keep')}
                        </button>
                    </span>
                ) : (
                    <button
                        type="button"
                        onClick={() => setConfirmRevoke(true)}
                        disabled={allOff}
                        className="text-[12px] font-medium disabled:opacity-40"
                        style={{ color: 'var(--text-primary)' }}
                        data-testid="nc-scope-revoke"
                    >
                        {t('nc_scope.revoke', 'Revoke all Nextcloud access')}
                    </button>
                )}
            </div>
        </div>
    );
};

export default NcScopeSection;
