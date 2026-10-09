import { NodeResizer } from '@xyflow/react';
import { StickyNote } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNodeRuntime } from '../NodeRuntimeContext';
import { renderNoteText } from './noteRichText';
import { useTranslation } from '../../../../../hooks/useTranslation';

/**
 * A free-floating canvas annotation (BFSF-411) — sticky-note text tied to a
 * position/size, persisted as a real `type: 'note'` step so it survives
 * save/export, but never wired into the flow: it has no connection handles
 * at all (see nodeDropTarget.js and applyAddNode.js for the "never gets an
 * edge" half of that guarantee; validate/graph.js's `edge.note_no_edges`
 * backstops it on the server).
 *
 * Editable in place — no settings panel:
 *   - double-click (or click the placeholder text) to edit; blur or Escape
 *     commits/cancels
 *   - drag a corner (when selected) to resize
 *   - a small swatch row (when selected) picks the note's colour
 *   - the text understands a tiny markup subset — **bold**, *italic*,
 *     `- ` bullets and `1. ` numbered lines (noteRichText.jsx, BFSF-479) —
 *     which renders styled once the edit commits
 *
 * A note is ALWAYS the canvas's background layer (BFSF-479): layout.js pins
 * it to z-index -1 beneath every node and connector, and the canvas never
 * elevates it on selection — a big coloured note is a grouping box, not a
 * card that competes with the flow. There is deliberately no
 * bring-to-front/send-to-back control.
 *
 * Writes go through NodeRuntimeContext's `onPatchStep` — the same
 * "a node edits its own fields, no edge surgery" seam every canvas-only
 * write uses. `onPatchStep` is null on a read-only canvas, which is what
 * disables every control here (no separate read-only flag needed).
 */

const NOTE_COLORS = {
    amber:  { border: 'border-amber-500/50',  bg: 'bg-amber-50 dark:bg-amber-500/10',   text: 'text-amber-900 dark:text-amber-100',  swatch: 'bg-amber-400' },
    blue:   { border: 'border-blue-500/50',   bg: 'bg-blue-50 dark:bg-blue-500/10',     text: 'text-blue-900 dark:text-blue-100',    swatch: 'bg-blue-400' },
    green:  { border: 'border-emerald-500/50', bg: 'bg-emerald-50 dark:bg-emerald-500/10', text: 'text-emerald-900 dark:text-emerald-100', swatch: 'bg-emerald-400' },
    orange: { border: 'border-orange-500/50', bg: 'bg-orange-50 dark:bg-orange-500/10', text: 'text-orange-900 dark:text-orange-100', swatch: 'bg-orange-400' },
    rose:   { border: 'border-rose-500/50',   bg: 'bg-rose-50 dark:bg-rose-500/10',     text: 'text-rose-900 dark:text-rose-100',    swatch: 'bg-rose-400' },
    red:    { border: 'border-red-500/50',    bg: 'bg-red-50 dark:bg-red-500/10',       text: 'text-red-900 dark:text-red-100',      swatch: 'bg-red-400' },
    cyan:   { border: 'border-cyan-500/50',   bg: 'bg-cyan-50 dark:bg-cyan-500/10',     text: 'text-cyan-900 dark:text-cyan-100',    swatch: 'bg-cyan-400' },
    slate:  { border: 'border-slate-400/50',  bg: 'bg-slate-100 dark:bg-slate-500/10',  text: 'text-slate-800 dark:text-slate-100',  swatch: 'bg-slate-400' },
};
// Swatch order — amber first (the default, so its swatch reads as "current"
// on a freshly dropped note with no color set yet).
const COLOR_KEYS = ['amber', 'blue', 'green', 'orange', 'rose', 'red', 'cyan', 'slate'];

export default function NoteNode({ id, data, selected }) {
    const { t } = useTranslation();
    const step = data?.step || {};
    const { onPatchStep } = useNodeRuntime();
    const editable = !!onPatchStep;
    const palette = NOTE_COLORS[step.color] || NOTE_COLORS.amber;

    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState('');
    const textareaRef = useRef(null);

    useEffect(() => { if (editing) textareaRef.current?.focus(); }, [editing]);

    const commit = useCallback(() => {
        setEditing(false);
        if (draft !== (step.text || '')) onPatchStep?.(id, { text: draft });
    }, [draft, step.text, onPatchStep, id]);

    // Snapshot the CURRENT text into the draft the moment editing starts,
    // rather than keeping `draft` continuously synced via an effect — the
    // definition (a reload, an undo, another session) may change while the
    // note sits un-edited, and reading `step.text` directly outside of
    // editing (see the display branch below) already shows that live,
    // without a second copy of the state to keep in step.
    const startEditing = useCallback((e) => {
        if (!editable) return;
        e.stopPropagation(); // never bubble into DiagramPane's "open settings panel" double-click
        setDraft(step.text || '');
        setEditing(true);
    }, [editable, step.text]);

    const setColor = useCallback((key) => {
        // amber is the implicit default — clearing back to it keeps a
        // freshly-dropped, never-recolored note from carrying an explicit
        // field that says nothing more than what omitting it already says.
        onPatchStep?.(id, { color: key === 'amber' ? undefined : key });
    }, [onPatchStep, id]);

    return (
        <div
            className={`group relative w-full h-full flex flex-col rounded-md border shadow-sm ${palette.border} ${palette.bg}`}
            onDoubleClick={startEditing}
        >
            <NodeResizer
                isVisible={editable && selected}
                minWidth={140}
                minHeight={72}
                maxWidth={2000}
                maxHeight={2000}
                lineClassName="!border-transparent"
                handleClassName="!w-2.5 !h-2.5 !rounded-sm !border !border-[var(--accent)] !bg-[var(--bg-primary)]"
                onResizeEnd={(_evt, params) => {
                    onPatchStep?.(id, { size: { width: Math.round(params.width), height: Math.round(params.height) } });
                }}
            />
            <div className={`flex items-center gap-1.5 px-2 pt-2 text-[10px] uppercase tracking-wide opacity-70 ${palette.text}`}>
                <StickyNote size={11} /> Note
            </div>
            <div className="flex-1 min-h-0 px-2 pb-2 pt-1">
                {editing ? (
                    <>
                        <textarea
                            ref={textareaRef}
                            className={`w-full h-full resize-none bg-transparent outline-none text-[12px] leading-snug ${palette.text}`}
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            onBlur={commit}
                            onKeyDown={(e) => {
                                // Escape discards the in-progress edit; every other
                                // key (including Enter — notes are multi-line) is
                                // ordinary typing and must not reach the canvas'
                                // own shortcuts (Delete/Backspace would otherwise
                                // delete the NODE while its own text is selected).
                                if (e.key === 'Escape') { setDraft(step.text || ''); setEditing(false); }
                                e.stopPropagation();
                            }}
                            onMouseDown={(e) => e.stopPropagation()}
                            placeholder={t('automations.note_node.write_a_note', 'Write a note…')}
                        />
                        <div className={`text-[9px] leading-tight opacity-50 select-none ${palette.text}`}>
                            {t('automations.note_node.bold_italic_bullet_1_numbered', '**bold** · *italic* · - bullet · 1. numbered')}
                        </div>
                    </>
                ) : (
                    <div
                        className={`w-full h-full overflow-auto break-words text-[12px] leading-snug ${palette.text} ${editable ? 'cursor-text' : ''}`}
                        onClick={editable ? startEditing : undefined}
                    >
                        {step.text
                            ? renderNoteText(step.text)
                            : (editable ? <span className="opacity-50 italic">{t('automations.note_node.double_click_to_write_a_note', 'Double-click to write a note…')}</span> : '(empty note)')}
                    </div>
                )}
            </div>
            {editable && selected && !editing && (
                <ColorSwatches current={step.color || 'amber'} onPick={setColor} />
            )}
        </div>
    );
}

/** The small colour-picker row shown under a selected note's text. */
function ColorSwatches({ current, onPick }) {
    return (
        <div
            className="flex items-center gap-1 px-2 pb-2"
            // Never let a swatch click start a node drag or reach the
            // canvas' own click handling.
            onMouseDown={(e) => e.stopPropagation()}
        >
            {COLOR_KEYS.map((key) => (
                <button
                    key={key}
                    type="button"
                    title={key}
                    aria-label={`Note colour: ${key}`}
                    onClick={(e) => { e.stopPropagation(); onPick(key); }}
                    className={`h-3.5 w-3.5 rounded-full ${NOTE_COLORS[key].swatch} ${
                        current === key ? 'ring-2 ring-offset-1 ring-[var(--text-primary)]' : 'opacity-70 hover:opacity-100'
                    }`}
                />
            ))}
        </div>
    );
}
