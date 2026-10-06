import { ChevronDown, ChevronRight, Search, X } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { canonicalRefPath, previewValue, walkPath } from '../../../../utils/bindingHelpers';
import { useTranslation } from '../../../../hooks/useTranslation';
import { listBadgeClass } from '../flow/settings/formStyles';
import { filterFields } from './filterFields';
import { startPathDrag } from './bindingDnd';
import { fieldListShape } from './listShape';
import { humanizeFieldKey } from '../flow/displayHelpers';
import { fieldValueLabel, friendlyBasePath } from './VariableTree';
import { fieldLabelText } from './upstream/routeFieldLabel';

/**
 * Portal-rendered popover that lists upstream variables, filterable by
 * name/path, with a hover preview of the resolved sample value at the
 * footer. Anchored to a DOM element supplied by the caller; flips above
 * the anchor when there isn't enough room below.
 *
 * Replaces the side-panel `activeFieldRef`/`onFocusField` indirection
 * for per-field insertion: the field owns the picker, so there's no
 * stale-handle window where the previously-focused input has unmounted.
 *
 * Props:
 *   open          — whether the popover is visible
 *   anchorEl      — DOM element to anchor against (typically the {} button)
 *   groups        — variable groups from useUpstreamVariables(...)
 *   onPick(path)  — called with the bare dotted path when the user selects a leaf
 *   onClose()     — called when the user dismisses (Escape, outside click, X button)
 *   previewSample — merged sample-root tree (same one BindingField uses for
 *                   inline previews); enables the footer "preview" line
 *   title         — optional aria/dialog label
 */
export default function VariablePicker({
    open,
    anchorEl,
    groups = [],
    onPick,
    onClose,
    previewSample = null,
    title = 'Insert variable',
    initialQuery = '',
    // The path being edited (a clicked pill). The picker opens SCOPED to
    // that path's step — the options you can pick in step 7 — with the
    // current field marked, and one click back to every step.
    focusPath = '',
}) {
    const [query, setQuery] = useState('');
    const [hoverField, setHoverField] = useState(null);
    const [scoped, setScoped] = useState(false);
    const { t } = useTranslation();
    const focusGroup = useMemo(() => groupForPath(groups, focusPath), [groups, focusPath]);
    const position = usePopoverPosition(anchorEl, open);

    // Reset query + hover whenever we re-open against a fresh anchor so the
    // user doesn't see stale filter state. Inline autocomplete seeds the
    // query via `initialQuery`; the plain {} button resets it to ''.
    // Intentional setState from useEffect — this is a UI sync (popover
    // lifecycle, not external state).
    useEffect(() => {
        if (open) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setQuery(initialQuery || '');

            setHoverField(null);
            setScoped(!!focusPath);
        }
    }, [open, anchorEl, initialQuery, focusPath]);

    useEffect(() => {
        if (!open) return undefined;
        const onKey = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                onClose?.();
            }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    useEffect(() => {
        if (!open) return undefined;
        // Defer one tick so the click that opened us doesn't immediately close us.
        let attached = false;
        const handler = (e) => {
            if (e.target.closest('[data-variable-picker]')) return;
            if (anchorEl && anchorEl.contains(e.target)) return;
            onClose?.();
        };
        const t = setTimeout(() => {
            document.addEventListener('mousedown', handler);
            attached = true;
        }, 0);
        return () => {
            clearTimeout(t);
            if (attached) document.removeEventListener('mousedown', handler);
        };
    }, [open, onClose, anchorEl]);

    const visible = scoped && focusGroup ? [focusGroup] : groups;
    const filteredGroups = useMemo(() => {
        if (!query) return visible;
        const q = query.toLowerCase();
        return visible
            .map(g => ({ ...g, fields: filterFields(g.fields || [], q) }))
            .filter(g => (g.fields || []).length > 0 || g.label?.toLowerCase().includes(q));
    }, [visible, query]);

    if (!open) return null;

    const previewLine = hoverField ? resolveLeafPreview(hoverField, previewSample) : null;

    return createPortal(
        <div
            data-variable-picker
            // z-[1200] keeps the picker ABOVE the Node Detail View overlay
            // (z-[1000]) — it's portaled to <body>, so a lower z renders behind
            // the NDV and the {} button appears to "do nothing".
            className="fixed z-[1200] w-[320px] flex flex-col bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-md shadow-lg"
            style={{ left: position.left, top: position.top, maxHeight: position.maxHeight }}
            role="dialog"
            aria-label={title}
        >
            <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border-default)]">
                <Search size={12} className="text-[var(--text-tertiary)]" />
                <input
                    type="text"
                    autoFocus
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={scoped && focusGroup ? t('automations.picker.search_in', 'Search in {step}…', { step: focusGroup.label }) : 'Search variables…'}
                    className="flex-1 bg-transparent text-xs text-[var(--text-primary)] focus:outline-none"
                />
                <button
                    type="button"
                    onClick={onClose}
                    className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                    aria-label="Close"
                >
                    <X size={12} />
                </button>
            </div>
            {scoped && focusGroup && (
                <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--border-default)] text-[11px] bg-[var(--bg-secondary)]" data-testid="picker-scope">
                    <span className="text-[var(--text-secondary)] truncate">{t('automations.picker.fields_of', 'Fields of {step}', { step: focusGroup.label })}</span>
                    <button type="button" onClick={() => setScoped(false)} className="ml-auto shrink-0 underline text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
                        {t('automations.picker.all_steps', 'All steps')}
                    </button>
                </div>
            )}
            <div className="flex-1 overflow-y-auto custom-scrollbar py-1">
                {filteredGroups.length === 0 ? (
                    <div className="px-3 py-4 text-[11px] text-[var(--text-tertiary)] italic">
                        {groups.length === 0
                            ? 'No upstream variables yet. Connect this step to a previous one to see its output here.'
                            : 'No matches.'}
                    </div>
                ) : filteredGroups.map(group => (
                    <PickerGroup
                        key={group.id}
                        group={group}
                        onPick={onPick}
                        onHoverField={setHoverField}
                        previewSample={previewSample}
                        currentPath={focusPath}
                        searching={!!query}
                    />
                ))}
            </div>
            <div className="px-3 py-2 border-t border-[var(--border-default)] text-[10px] text-[var(--text-tertiary)] min-h-[28px] flex items-center gap-1.5">
                {previewLine != null ? (
                    <>
                        <span className="uppercase tracking-wide">preview</span>
                        <span
                            className="font-mono text-[var(--text-secondary)] truncate"
                            title={previewLine}
                        >
                            {previewLine}
                        </span>
                    </>
                ) : (
                    <span>Hover a field to preview its sample value.</span>
                )}
            </div>
        </div>,
        document.body,
    );
}

function PickerGroup({ group, onPick, onHoverField, previewSample = null, currentPath = '', searching = false }) {
    const [open, setOpen] = useState(true);
    const caption = friendlyBasePath(group.basePath, group.label);
    return (
        <div className="border-b border-[var(--border-default)] last:border-b-0">
            <button
                type="button"
                onClick={() => setOpen(o => !o)}
                // The base path lives on the header itself, so it stays one
                // hover away even for a group whose caption is dropped as a
                // stutter of its own label.
                title={group.basePath}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--bg-secondary)]"
            >
                {open
                    ? <ChevronDown size={12} className="text-[var(--text-tertiary)]" />
                    : <ChevronRight size={12} className="text-[var(--text-tertiary)]" />}
                <span className="text-[var(--text-primary)] font-medium truncate">{group.label}</span>
                {/* This popover is the control that exists so nobody has to know
                    the path — and it led with one, in monospace, id and all
                    (`steps.act_4d3307a.output`). The caption now says it in
                    words, exactly as VariableTree's group row does; the raw
                    base path stays in the `title`, because it is still the
                    string a power user copies into an expression. Demote it,
                    never delete it. */}
                {caption && (
                    <span
                        className="ml-auto text-[10px] text-[var(--text-tertiary)] truncate max-w-[140px]"
                        title={group.basePath}
                    >
                        {caption}
                    </span>
                )}
            </button>
            {open && (group.fields || []).length === 0 && (
                <div className="px-6 py-1 text-[11px] text-[var(--text-tertiary)] italic">No fields</div>
            )}
            {open && (group.fields || []).map(f => (
                <PickerLeaf
                    key={f.path}
                    field={f}
                    depth={1}
                    onPick={onPick}
                    onHoverField={onHoverField}
                    previewSample={previewSample}
                    currentPath={currentPath}
                    searching={searching}
                />
            ))}
        </div>
    );
}

function PickerLeaf({ field, depth, onPick, onHoverField, previewSample = null, currentPath = '', searching = false }) {
    // null = the author has not toggled this row: closed normally, OPEN while
    // searching, so a match deep in a list ("address" under Value ▸ From ▸
    // Email address) is on screen rather than behind a collapsed parent.
    const [toggled, setToggled] = useState(null);
    // By meaning, not spelling: the pill may say `['k']`, the tree `["k"]`.
    const isCurrent = !!currentPath && canonicalRefPath(field.path) === canonicalRefPath(currentPath);
    const hasChildren = Array.isArray(field.children) && field.children.length > 0;
    const expanded = toggled ?? (searching && hasChildren);
    const setExpanded = (fn) => setToggled(fn(expanded));
    const indent = 12 + depth * 14;
    // Announce a list before it is picked, with the TRUE flattened count —
    // `field.sample` for a `[*]` path is the first ELEMENT, so counts read
    // from it were simply wrong.
    const shape = fieldListShape(field, previewSample);

    const handleClick = (e) => {
        if (hasChildren && e.target.closest('[data-expand-btn]')) {
            setExpanded(o => !o);
            return;
        }
        onPick?.(field.path, { raw: e.altKey });
    };

    return (
        <>
            <div
                role="button"
                tabIndex={0}
                // Also a DRAG SOURCE. Every field editor in both builders already
                // accepts an `application/x-binding-path` drop, but the only
                // element that ever produced one was VariableTree's row — a panel
                // App Studio never renders, so its drop targets were unreachable
                // there. One attribute here makes them live in both.
                draggable
                onDragStart={(e) => startPathDrag(e, field.path)}
                onClick={handleClick}
                onMouseEnter={() => onHoverField(field)}
                onMouseLeave={() => onHoverField(null)}
                onFocus={() => onHoverField(field)}
                onBlur={() => onHoverField(null)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onPick?.(field.path, { raw: e.altKey });
                    }
                }}
                aria-current={isCurrent ? 'true' : undefined}
                className={`group flex items-center gap-2 py-1 text-[11px] cursor-pointer select-none hover:bg-[var(--bg-secondary)] focus:bg-[var(--bg-secondary)] focus:outline-none ${isCurrent ? 'bg-[var(--bg-tertiary)] font-semibold' : ''}`}
                style={{ paddingLeft: indent, paddingRight: 8 }}
                title={field.path}
            >
                {hasChildren ? (
                    <button
                        type="button"
                        data-expand-btn
                        onClick={(e) => { e.stopPropagation(); setExpanded(o => !o); }}
                        className="shrink-0 p-0.5 -m-0.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                        aria-label={expanded ? 'Collapse' : 'Expand'}
                    >
                        {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                    </button>
                ) : (
                    <span className="shrink-0 w-3" />
                )}
                {/* The name of the thing, not its key: "Klant naam", never
                    `klant_naam` (displayHelpers.humanizeFieldKey — the same
                    humaniser the Condition field picker uses). The exact key
                    keeps its own `title` here and the whole row still carries
                    the full dotted path, so the one string an expression needs
                    is one hover away. */}
                <LeafText field={field} shape={shape} previewSample={previewSample} hasChildren={hasChildren} />
            </div>
            {hasChildren && expanded && field.children.map(c => (
                <PickerLeaf
                    key={c.path}
                    field={c}
                    depth={depth + 1}
                    onPick={onPick}
                    onHoverField={onHoverField}
                    previewSample={previewSample}
                    currentPath={currentPath}
                    searching={searching}
                />
            ))}
        </>
    );
}

/** The group whose basePath owns `path` — the longest one that is a prefix. */
function groupForPath(groups, path) {
    const p = canonicalRefPath(String(path || '').trim());
    if (!p) return null;
    let best = null;
    for (const g of groups || []) {
        const base = g.basePath ? canonicalRefPath(String(g.basePath)) : '';
        if (!base) continue;
        if (p === base || p.startsWith(`${base}.`) || p.startsWith(`${base}[`)) {
            if (!best || base.length > String(best.basePath).length) best = g;
        }
    }
    return best;
}

function resolveLeafPreview(field, sampleRoot) {
    if (!field) return null;
    if (sampleRoot) {
        const v = walkPath(field.path, sampleRoot);
        if (v !== undefined) return previewValue(v, 60);
    }
    if (field.sample !== undefined) return previewValue(field.sample, 60);
    return null;
}

/**
 * A row's name, its list badge and its example. The name has priority over
 * the other two: "Tags" must never shrink to "T…" to make room for sample text.
 */
function LeafText({ field, shape, previewSample, hasChildren }) {
    const { t } = useTranslation();
    return (
        <>
            <span className="text-[var(--text-primary)] truncate shrink-0 max-w-[60%]" title={field.key} data-picker-name="">
                {fieldLabelText(field, t) ?? (humanizeFieldKey(field.key) || field.key)}
            </span>
            {shape && (
                <span className={listBadgeClass()} title={t(shape.explainKey, shape.explainEn, shape.explainParams)}>
                    {shape.count != null ? `${t('automations.builder.list_word', 'list')} · ${shape.count}` : t('automations.builder.list_word', 'list')}
                </span>
            )}
            <span className="ml-auto min-w-0 text-right text-[10px] text-[var(--text-tertiary)] truncate">
                {leafValueText(field, previewSample, t, hasChildren)}
            </span>
        </>
    );
}

/**
 * What a row shows after its name: the Comes-in panel's own wording
 * (VariableTree.fieldValueLabel) — a column's first values "a · b · c", a
 * text “quoted” — so the {} picker and the panel never describe one field two
 * ways. Only a list of records that does not open into its columns keeps its
 * count ("[3 items]"), where the panel's wording is empty.
 */
function leafValueText(field, previewSample, t, hasChildren = false) {
    const label = fieldValueLabel(field, previewSample, t);
    if (label) return label;
    // A row that opens into its own fields shows them there; its count would
    // only repeat the "list · n" badge beside it.
    if (hasChildren) return '';
    const v = resolveLeafSample(field, previewSample);
    return Array.isArray(v) ? previewValue(v, 24) : '';
}

/**
 * The value a row's inline preview shows. For a `[*]` column path the stored
 * `field.sample` is the FIRST ELEMENT (collectionItemsFields convention), so
 * resolving through walkPath is the only honest source; plain paths keep the
 * cheap field.sample fallback.
 */
function resolveLeafSample(field, sampleRoot) {
    if (sampleRoot && String(field.path || '').includes('[*]')) {
        const v = walkPath(field.path, sampleRoot);
        if (v !== undefined) return v;
    }
    return field.sample;
}

/**
 * Place the popover against its anchor. Same rules AnchoredMenu applies to the
 * field dropdowns (BFSF-328): prefer below, flip only when it truly does not
 * fit AND above is roomier, then cap the height to the room that is actually
 * there so the panel is always fully reachable. It is not AnchoredMenu itself
 * because this popover is a flex column with a sticky search header and a
 * preview footer — it owns its own inner scroller.
 *
 * Exported: ListPickChooser anchors and flips with the same rules, so the two
 * popovers a field can open never behave differently.
 */
export function usePopoverPosition(anchorEl, open) {
    const [pos, setPos] = useState({ left: 0, top: 0, maxHeight: 420 });
    useEffect(() => {
        if (!open || !anchorEl) return undefined;
        const update = () => {
            const r = anchorEl.getBoundingClientRect();
            const width = 320;
            const margin = 8;
            const gap = 4;
            const below = window.innerHeight - r.bottom - margin - gap;
            const above = r.top - margin - gap;
            const flip = below < 240 && above > below;
            const maxHeight = Math.max(160, Math.min(420, Math.floor(flip ? above : below)));
            const top = flip
                ? Math.max(margin, Math.round(r.top - gap - maxHeight))
                : Math.round(r.bottom + gap);
            let left = r.left;
            if (left + width > window.innerWidth - margin) left = window.innerWidth - width - margin;
            if (left < margin) left = margin;
            setPos(p => (p.left === left && p.top === top && p.maxHeight === maxHeight ? p : { left, top, maxHeight }));
        };
        update();
        window.addEventListener('resize', update);
        window.addEventListener('scroll', update, true);
        return () => {
            window.removeEventListener('resize', update);
            window.removeEventListener('scroll', update, true);
        };
    }, [anchorEl, open]);
    return pos;
}
