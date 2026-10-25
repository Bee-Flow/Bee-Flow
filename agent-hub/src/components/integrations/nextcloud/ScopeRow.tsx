import { useEffect, useState, useEffectEvent } from 'react';
import { ChevronRight, ChevronDown, Search, Loader2, Folder, FolderOpen } from 'lucide-react';
import { API_BASE, authFetch } from '../../../utils/helpers';
import SegmentedControl from '../../shared/SegmentedControl';
import type { TFn, ScopeResource, ScopeEntry, FolderNodeProps, FolderTreePickerProps, ResourcePickerProps, ScopeRowProps } from './NcScopeSection.types';

export const MODE_ALL = 'all';

export const MODE_SELECTED = 'selected';

export const MODE_OFF = 'off';

const PANEL_ANIM = 'modelTierPanelIn 140ms cubic-bezier(0.22, 1, 0.36, 1) both';

function scopeWords(t: TFn, entry: ScopeEntry) {
    if (!entry || entry.mode === MODE_ALL) return t('nc_scope.everything', 'Everything');
    if (entry.mode === MODE_OFF) return t('nc_scope.off', 'Off');
    const n = (entry.selected || []).length;
    const label = entry.resource?.label || t('nc_scope.items', 'items');
    if (n === 0) return t('nc_scope.none_selected', 'Nothing selected');
    return `${n} ${label}`;
}

const FolderNode = ({ path, label, depth, selected, onToggle, t }: FolderNodeProps) => {
    const [expanded, setExpanded] = useState(false);
    const [children, setChildren] = useState<ScopeResource[] | null>(null); // null = not fetched
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const checked = selected.includes(path);
    // An ancestor selection already covers this folder — show it as
    // implicitly on, so the tree reads like the enforcement behaves.
    const covered = !checked && selected.some((sel: string) => sel === '/' || path === sel || path.startsWith(sel + '/'));

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
                    className="p-0.5 rounded flex-shrink-0 text-[var(--text-tertiary)]"
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
                        ? <FolderOpen size={14} className="flex-shrink-0 text-[var(--text-tertiary)]" />
                        : <Folder size={14} className="flex-shrink-0 text-[var(--text-tertiary)]" />}
                    <span className="text-[13px] truncate text-[var(--text-primary)]">{label}</span>
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

const FolderTreePicker = ({ selected, onToggle, t }: FolderTreePickerProps) => (
    <div className="max-h-72 overflow-auto rounded-lg p-1.5 [border:1px_solid_var(--border-subtle)] [background:var(--bg-primary)]" data-testid="nc-scope-folder-tree">
        <FolderNode path="/" label={t('nc_scope.all_files_root', 'All files')} depth={0} selected={selected} onToggle={onToggle} t={t} />
    </div>
);

const ResourcePicker = ({ integrationId, resourceLabel, selected, onToggle, t }: ResourcePickerProps) => {
    const [resources, setResources] = useState<ScopeResource[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [query, setQuery] = useState('');

    const runTEffect = useEffectEvent(() => {
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
    });
    useEffect(() => { return runTEffect(); }, [integrationId]);

    if (error) return <p className="text-[11px] text-[var(--text-muted)]">{error}</p>;
    if (resources === null) {
        return (
            <p className="flex items-center gap-2 text-[11px] text-[var(--text-tertiary)]">
                <Loader2 size={12} className="animate-spin" /> {t('nc_scope.loading', 'Loading…')}
            </p>
        );
    }

    const q = query.trim().toLowerCase();
    const visible = q ? resources.filter((r) => r.label.toLowerCase().includes(q)) : resources;
    // Selections whose resource no longer exists (deleted calendar, left
    // room) still bind server-side — show them so they can be unticked.
    const orphaned = selected.filter(id => !resources.some((r) => r.id === id));

    return (
        <div data-testid={`nc-scope-picker-${integrationId}`}>
            {resources.length > 8 && (
                <div className="flex items-center gap-2 px-3 py-1.5 mb-2 rounded-lg [background:var(--bg-primary)] [border:1px_solid_var(--border-subtle)]">
                    <Search size={13} className="text-[var(--text-tertiary)]" />
                    <input
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        placeholder={t('nc_scope.search', 'Search…')}
                        aria-label={t('nc_scope.search', 'Search…')}
                        className="flex-1 bg-transparent outline-none text-[13px] [color:var(--text-primary)]!"
                    />
                </div>
            )}
            <div className="max-h-72 overflow-auto space-y-0.5">
                {visible.length === 0 && (
                    <p className="text-[11px] italic py-1 text-[var(--text-tertiary)]">
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
                            <span className="text-[13px] truncate text-[var(--text-primary)]">{r.label}</span>
                        </label>
                    );
                })}
                {orphaned.map(id => (
                    <label key={id} className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg cursor-pointer" data-testid={`nc-scope-resource-${id}`}>
                        <input type="checkbox" className="w-4 h-4 accent-[var(--accent-primary)] flex-shrink-0" checked onChange={() => onToggle(id)} />
                        <span className="text-[13px] italic truncate text-[var(--text-muted)]">
                            {id} · {t('nc_scope.orphaned', 'no longer found')}
                        </span>
                    </label>
                ))}
            </div>
            <p className="text-[11px] mt-2 text-[var(--text-tertiary)]">
                {selected.length === 0
                    ? t('nc_scope.none_hint', 'Nothing selected yet — Bee Flow can reach none of your {items} until you tick some.')
                        .replace('{items}', resourceLabel)
                    : null}
            </p>
        </div>
    );
};

export const ScopeRow = ({ id, entry, last, onModeChange, onSelectionSave, t }: ScopeRowProps) => {
    const [open, setOpen] = useState(false);
    // Selection edits buffer locally; Done persists. Mode changes persist
    // immediately — flipping to Off must not wait behind a picker.
    const [draft, setDraft] = useState(entry.selected || []);
    const [prevSelected, setPrevSelected] = useState(entry.selected);
    if (prevSelected !== entry.selected) {
        setPrevSelected(entry.selected);
        setDraft(entry.selected || []);
    }

    const narrowed = entry.mode !== MODE_ALL;
    const dirty = JSON.stringify(draft) !== JSON.stringify(entry.selected || []);

    const toggleDraft = (rid: string) => {
        setDraft(d => (d.includes(rid) ? d.filter(x => x !== rid) : [...d, rid]));
    };

    return (
        <div style={{ borderBottom: last ? 'none' : '1px solid var(--border-subtle)' }}>
            <button
                type="button"
                className="w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors [background:var(--bg-secondary)]"
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-tertiary)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-secondary)'; }}
                onClick={() => setOpen(v => !v)}
                aria-expanded={open}
                data-testid={`nc-scope-row-${id}`}
            >
                <span className="flex-1 min-w-0 text-[13px] font-medium truncate text-[var(--text-primary)]">
                    {entry.name}
                </span>
                {narrowed && (
                    <span
                        className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-[var(--warning)]"
                        aria-hidden="true"
                        data-testid={`nc-scope-dot-${id}`}
                    />
                )}
                <span className="text-[13px] flex-shrink-0 text-[var(--text-secondary)]" data-testid={`nc-scope-words-${id}`}>
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
                            <div className="flex items-center justify-between pt-1 [border-top:1px_solid_var(--border-subtle)]">
                                <button
                                    type="button"
                                    disabled={draft.length === 0}
                                    onClick={() => setDraft([])}
                                    className="text-[12px] disabled:opacity-40 text-[var(--text-muted)]"
                                    data-testid={`nc-scope-clear-${id}`}
                                >
                                    {t('nc_scope.clear', 'Clear')}
                                </button>
                                <button
                                    type="button"
                                    disabled={!dirty}
                                    onClick={() => onSelectionSave(id, draft)}
                                    className="px-4 py-1.5 rounded-lg text-[13px] font-medium disabled:opacity-40 [background:var(--accent-primary)] [color:var(--accent-primary-fg,#fff)]!"
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
