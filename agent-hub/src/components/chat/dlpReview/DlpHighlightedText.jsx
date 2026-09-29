/**
 * Renders `text` with `spans` highlighted inline (category color + a click
 * popover with the badge), and lets the user select any plain-text run and
 * mark it as personal data the detector missed — the manual-add
 * interaction the review UI exists for.
 *
 * Offset mapping: every run (plain text AND highlighted span) is rendered as
 * its own DOM node, in source order, with no characters added or removed —
 * so a TreeWalker over this container's text nodes reconstructs the exact
 * same offsets `text` was built from. No contentEditable, no per-run
 * data-offset bookkeeping needed.
 *
 * `baseOffset` lets this render a WINDOW into a larger document (e.g. one
 * table cell out of a whole spreadsheet's flat text — see
 * DlpSpreadsheetRenderer): `text`/`spans` are LOCAL to that window (offset 0
 * = the window's own start), and every offset this component reports back
 * via onAddSpan is translated to the window's ABSOLUTE position first, so
 * every caller (and the server) keeps working in one coordinate system —
 * the whole document's — regardless of how a renderer chops it up visually.
 */
import { Plus } from 'lucide-react';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import DlpCategoryBadge from './DlpCategoryBadge';
import { buildRuns } from './dlpFindingsState';
import { categoryStyle } from '../../../config/dlpCategoryColors';
import { useTranslation } from '../../../hooks/useTranslation';
import { textOffsetFromPoint } from '../../../utils/textSelection';
import AnchoredMenu from '../../shared/AnchoredMenu';

/** A fixed-position 0-size node AnchoredMenu can anchor a popover to a DOMRect (not a real trigger element). */
function useVirtualAnchor(rect) {
    const ref = useRef(null);
    return {
        ref,
        node: rect ? (
            <span
                ref={ref}
                aria-hidden="true"
                style={{ position: 'fixed', top: rect.top, left: rect.left, width: rect.width || 1, height: rect.height || 1, pointerEvents: 'none' }}
            />
        ) : null,
    };
}

export default function DlpHighlightedText({ text, spans, onAddSpan, onRemoveSpan, baseOffset = 0, dense = false }) {
    const { t } = useTranslation();
    const containerRef = useRef(null);
    const [pendingSelection, setPendingSelection] = useState(null); // {offset, length, text, rect}
    const [openSpanKey, setOpenSpanKey] = useState(null);
    const spanAnchorRef = useRef(null);

    const runs = useMemo(() => buildRuns(text || '', spans || []), [text, spans]);
    const pendingAnchor = useVirtualAnchor(pendingSelection?.rect);

    const handleMouseUp = useCallback(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
        const range = sel.getRangeAt(0);
        const container = containerRef.current;
        if (!container || !container.contains(range.commonAncestorContainer)) return;

        const a = textOffsetFromPoint(container, range.startContainer, range.startOffset);
        const b = textOffsetFromPoint(container, range.endContainer, range.endOffset);
        const offset = Math.min(a, b);
        const length = Math.abs(b - a);
        if (length <= 0) return;

        // Already (fully) covered by an existing span — nothing new to mark.
        const alreadyCovered = (spans || []).some(s => offset >= s.offset && offset + length <= s.offset + s.length);
        if (alreadyCovered) { sel.removeAllRanges(); return; }

        const rect = range.getBoundingClientRect();
        setPendingSelection({ offset, length, text: text.slice(offset, offset + length), rect });
    }, [spans, text]);

    const confirmMark = () => {
        if (!pendingSelection) return;
        // Local → absolute: the parent (and eventually the server) only ever
        // deals in whole-document offsets, never in "offset within this cell".
        onAddSpan?.({ offset: pendingSelection.offset + baseOffset, length: pendingSelection.length, text: pendingSelection.text });
        setPendingSelection(null);
        window.getSelection()?.removeAllRanges();
    };
    const dismissMark = () => {
        setPendingSelection(null);
        window.getSelection()?.removeAllRanges();
    };

    const openSpan = spans?.find(s => s.id === openSpanKey);

    return (
        <div
            ref={containerRef}
            onMouseUp={handleMouseUp}
            className={dense
                ? 'whitespace-pre-wrap break-words text-xs select-text'
                : 'whitespace-pre-wrap break-words leading-relaxed text-sm select-text'}
        >
            {runs.map((r, i) => {
                if (r.type === 'text') return <span key={`t${i}`}>{r.value}</span>;
                const key = r.id || `s${i}`;
                const style = categoryStyle(r.category, r.confidenceBand);
                return (
                    <mark
                        key={key}
                        ref={openSpanKey === key ? spanAnchorRef : undefined}
                        onClick={(e) => { e.stopPropagation(); setOpenSpanKey(k => (k === key ? null : key)); }}
                        className="rounded px-0.5 py-px cursor-pointer border-b-2"
                        style={{ background: style.background, borderColor: style.borderColor, color: 'inherit' }}
                        title={r.text}
                    >
                        {r.value}
                    </mark>
                );
            })}

            {/* "Mark as personal data" popover — appears on a fresh selection. */}
            {pendingAnchor.node}
            <AnchoredMenu
                open={!!pendingSelection}
                onClose={dismissMark}
                anchorRef={pendingAnchor.ref}
                align="left"
                width={240}
                role="menu"
                className="p-2"
                style={{ background: 'var(--bg-card)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
            >
                <button
                    type="button"
                    role="menuitem"
                    onClick={confirmMark}
                    className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded text-xs font-medium hover:bg-[var(--bg-tertiary)]"
                >
                    <Plus className="w-3.5 h-3.5" style={{ color: 'var(--pii-cat-8)' }} />
                    {t('dlp.mark_as_pii', 'Mark as personal data')}
                </button>
            </AnchoredMenu>

            {/* Category badge popover — appears on clicking an existing highlight. */}
            <AnchoredMenu
                open={!!openSpan}
                onClose={() => setOpenSpanKey(null)}
                anchorRef={spanAnchorRef}
                align="left"
                width={220}
                role="menu"
                className="p-2 space-y-2"
                style={{ background: 'var(--bg-card)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
            >
                {openSpan && (
                    <>
                        <DlpCategoryBadge categoryId={openSpan.category} source={openSpan.source} confidenceBand={openSpan.confidenceBand} />
                        {openSpan.source === 'manual' && onRemoveSpan && (
                            <button
                                type="button"
                                role="menuitem"
                                onClick={() => { onRemoveSpan(openSpan.id); setOpenSpanKey(null); }}
                                className="w-full text-left px-2 py-1 rounded text-xs hover:bg-[var(--bg-tertiary)]"
                                style={{ color: 'var(--text-secondary)' }}
                            >
                                {t('dlp.unmark', 'Unmark')}
                            </button>
                        )}
                    </>
                )}
            </AnchoredMenu>
        </div>
    );
}
