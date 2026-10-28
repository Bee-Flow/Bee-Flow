import { Search, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from '../../../../hooks/useTranslation';
import { filterFields } from './filterFields';
import { type ListShape } from './listShape';
import type { GroupField } from './deepFields';
import type { VariablePickerProps } from './VariablePicker.types';
import { groupForPath, resolveLeafPreview } from './VariablePicker.helpers';
import { PickerGroup } from './PickerGroup';

function PreviewFooter({ previewLine }: { previewLine: string | null }) {
    const { t } = useTranslation();
    if (previewLine == null) {
        return <span>{t('automations.variable_picker.hover_a_field_to_preview_its', 'Hover a field to preview its sample value.')}</span>;
    }
    return (
        <>
            <span className="uppercase tracking-wide">{t('automations.variable_picker.preview', 'preview')}</span>
            <span
                className="font-mono text-[var(--text-secondary)] truncate"
                title={previewLine}
            >
                {previewLine}
            </span>
        </>
    );
}

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
}: VariablePickerProps) {
    const [query, setQuery] = useState('');
    const [hoverField, setHoverField] = useState<GroupField | null>(null);
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
        const onKey = (e: KeyboardEvent) => {
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
        const handler = (e: MouseEvent) => {
            if ((e.target as Element).closest('[data-variable-picker]')) return;
            if (anchorEl && anchorEl.contains(e.target as Node | null)) return;
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

    // Scoped to the clicked pill's own step until the author asks for every step.
    const scopeGroup = scoped ? focusGroup : null;
    const visible = useMemo(() => (scopeGroup ? [scopeGroup] : groups), [scopeGroup, groups]);
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
                    placeholder={scopeGroup ? t('automations.picker.search_in', 'Search in {step}…', { step: scopeGroup.label }) : 'Search variables…'}
                    className="flex-1 bg-transparent text-xs text-[var(--text-primary)] focus:outline-none"
                />
                <button
                    type="button"
                    onClick={onClose}
                    className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                    aria-label={t('automations.variable_picker.close', 'Close')}
                >
                    <X size={12} />
                </button>
            </div>
            {scopeGroup && (
                <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--border-default)] text-[11px] bg-[var(--bg-secondary)]" data-testid="picker-scope">
                    <span className="text-[var(--text-secondary)] truncate">{t('automations.picker.fields_of', 'Fields of {step}', { step: scopeGroup.label })}</span>
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
                <PreviewFooter previewLine={previewLine} />
            </div>
        </div>,
        document.body,
    );
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
export function usePopoverPosition(anchorEl: HTMLElement | null, open: boolean) {
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
