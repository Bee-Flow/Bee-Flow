import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, Check, History, ListChecks, Clock, Pencil } from 'lucide-react';
import useTranslation from '../../../hooks/useTranslation';
// The strict parser (null for junk), NOT parseTimestampToSeconds (junk → 0):
// an unreadable model timestamp must lose its chip, not seek to 0:00.
import { toSeconds } from '../lib/timelineMarkers';
import DestinationPicker from './DestinationPicker';

/**
 * The action cards (Meeting Notes artboard 1a, right column).
 *
 * ── WHO SEES A DESTINATION ──────────────────────────────────────────
 * The chip names another object — a routine, a table, a knowledge base — that
 * lives in the OWNER's workspace, and a published note is read by colleagues
 * who may have no access to any of the three. So the chip is drawn only when
 * `onSetDestination` is given, which MeetingDetail does for the owner alone.
 * Same narrowing the server already makes for the Used-by rows, where
 * `redactForeign` withholds the title of anything owned by someone else: the
 * existence of a link is not what needs hiding, the NAME is.
 */
export default function ActionItemsList({ items = [], meeting = null, onToggle, onEdit, onSeek, onSetDestination }) {
    const { t } = useTranslation();
    const [editingId, setEditingId] = useState(null);
    const [draft, setDraft] = useState('');

    // When any item carries a spoken deadline, dated items float up in due
    // order; undated ones keep their original (discussion) order below.
    // Stable sort, so toggling done never reshuffles rows.
    const sorted = useMemo(() => {
        if (!items.some((i) => i && i.due)) return items;
        return [...items].sort((a, b) => (a.due && b.due
            ? a.due.localeCompare(b.due)
            : a.due ? -1 : b.due ? 1 : 0));
    }, [items]);

    const startEdit = (item) => {
        if (!onEdit) return;
        setEditingId(item.id);
        setDraft(item.text || '');
    };

    const cancelEdit = () => {
        setEditingId(null);
        setDraft('');
    };

    const commitEdit = (item) => {
        const trimmed = draft.trim();
        if (trimmed && trimmed !== item.text) {
            onEdit?.(item.id, trimmed);
        }
        cancelEdit();
    };

    return (
        <div className="flex flex-col gap-3 h-full">
            <h2 className="text-sm font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                <ListChecks className="w-4 h-4" aria-hidden="true" />
                {t('meetings.action_items', 'Action items')}
                <span className="text-[11px] font-medium px-1.5 py-0.5 rounded-full" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>
                    {items.filter((i) => !i.done).length}
                </span>
            </h2>
            <div className="flex-1 overflow-auto rounded-xl border" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)' }}>
                {items.length === 0 ? (
                    <div className="text-sm text-center py-10 px-4" style={{ color: 'var(--text-muted)' }}>
                        {t('meetings.no_action_items', 'No action items detected.')}
                    </div>
                ) : (
                    <ul className="divide-y" style={{ borderColor: 'var(--border-subtle)' }}>
                        {sorted.map((item) => (
                            <ActionItemRow
                                key={item.id}
                                item={item}
                                editing={editingId === item.id}
                                draft={draft}
                                onDraftChange={setDraft}
                                onToggle={() => onToggle?.(item.id)}
                                onStartEdit={() => startEdit(item)}
                                onCommit={() => commitEdit(item)}
                                onCancel={cancelEdit}
                                onSeek={onSeek}
                                canEdit={!!onEdit}
                                meeting={meeting}
                                onSetDestination={onSetDestination}
                                t={t}
                            />
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}

function ActionItemRow({ item, editing, draft, onDraftChange, onToggle, onStartEdit, onCommit, onCancel, onSeek, canEdit, meeting, onSetDestination, t }) {
    const inputRef = useRef(null);
    useEffect(() => {
        if (editing && inputRef.current) {
            inputRef.current.focus();
            inputRef.current.select();
        }
    }, [editing]);

    return (
        <li className="px-3 py-2.5 flex items-start gap-3 group">
            <button
                type="button"
                onClick={onToggle}
                aria-label={item.done ? t('meetings.mark_not_done', 'Mark not done') : t('meetings.mark_done', 'Mark done')}
                className="mt-0.5 w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-colors"
                style={{
                    background: item.done ? 'var(--accent-primary)' : 'transparent',
                    borderColor: item.done ? 'var(--accent-primary)' : 'var(--border-default)',
                }}
            >
                {item.done && <Check className="w-3 h-3" style={{ color: 'var(--accent-primary-fg)' }} aria-hidden="true" />}
            </button>
            <div className="flex-1 min-w-0">
                {editing ? (
                    <input
                        ref={inputRef}
                        value={draft}
                        onChange={(e) => onDraftChange(e.target.value)}
                        onBlur={onCommit}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); onCommit(); }
                            if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
                        }}
                        aria-label={t('meetings.edit_action_item', 'Edit action item')}
                        className="w-full px-2 py-1 rounded text-sm border outline-none"
                        style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                    />
                ) : (
                    <button
                        type="button"
                        onClick={canEdit ? onStartEdit : undefined}
                        disabled={!canEdit}
                        className={`text-left text-sm w-full ${item.done ? 'line-through opacity-60' : ''} ${canEdit ? 'cursor-text hover:bg-[var(--bg-tertiary)] rounded px-1 -mx-1 transition-colors' : ''}`}
                        style={{ color: 'var(--text-primary)' }}
                        title={canEdit ? t('meetings.click_to_edit', 'Click to edit') : undefined}
                    >
                        {item.text}
                        {canEdit && <Pencil className="inline w-3 h-3 ml-1.5 opacity-0 group-hover:opacity-50 transition-opacity align-baseline" aria-hidden="true" />}
                    </button>
                )}
                <ActionItemMeta
                    item={item}
                    onSeek={onSeek}
                    meeting={meeting}
                    onSetDestination={onSetDestination}
                    t={t}
                />
            </div>
        </li>
    );
}

/** The line under the sentence: who, when, by when — and where it went. */
function ActionItemMeta({ item, onSeek, meeting, onSetDestination, t }) {
    return (
        <div className="flex items-center gap-2 mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {item.assignee && (
                <span className="inline-flex items-center gap-1">
                    <span className="w-4 h-4 rounded-full text-[9px] font-semibold flex items-center justify-center" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }} aria-hidden="true">
                        {(item.assignee[0] || '?').toUpperCase()}
                    </span>
                    {item.assignee}
                </span>
            )}
            {onSeek && toSeconds(item.timestamp) !== null && (
                <button
                    type="button"
                    onClick={() => onSeek(toSeconds(item.timestamp))}
                    className="inline-flex items-center gap-1 hover:text-[var(--accent-primary)] transition-colors"
                >
                    <Clock className="w-3 h-3" aria-hidden="true" />
                    {item.timestamp}
                </button>
            )}
            {item.due && <DueChip due={item.due} done={item.done} t={t} />}
            {item.orphaned && <KeptChip t={t} />}
            {/* Right-aligned, after the avatar / seek / deadline that artboard
                1a keeps exactly as they were. */}
            {onSetDestination && (
                <DestinationPicker
                    item={item}
                    meeting={meeting}
                    onPicked={(destination) => onSetDestination(item.id, destination)}
                />
            )}
        </div>
    );
}

/**
 * "Bewaard" — de nieuwste AI-pass leverde dit punt niet meer op, maar het is
 * blijven staan omdat iemand het had afgevinkt of de tekst had overgetypt.
 *
 * De server kan zo'n punt niet meer herkennen in de verse lijst (zie
 * `anchorKey` in server/core/meetingNotes/actionItems.js) en weggooien-en-
 * opnieuw-aanmaken zou de menselijke invoer alsnog wissen. Dus blijft het
 * staan — en dan moet de kaart dat ZEGGEN, anders beweert hij dat de AI dit
 * zojuist heeft opgeleverd.
 */
function KeptChip({ t }) {
    return (
        <span
            className="inline-flex items-center gap-1"
            style={{ color: 'var(--warning)' }}
            title={t('meetings.action_kept_title', 'The latest regeneration no longer found this action. It was kept because it had been checked off or edited — nothing was deleted.')}
        >
            <History className="w-3 h-3" aria-hidden="true" />
            {t('meetings.action_kept', 'kept')}
        </span>
    );
}

/** Spoken deadline ("YYYY-MM-DD"); --error once it's past and the item isn't done. */
function DueChip({ due, done, t }) {
    // Compare against the viewer's LOCAL date. toISOString() is UTC, which in
    // CEST turns an item due today into "overdue" for the first two hours
    // after midnight.
    const overdue = !done && due < localToday();
    return (
        <span
            className="inline-flex items-center gap-1 tabular-nums"
            style={{ color: overdue ? 'var(--error)' : 'var(--text-muted)' }}
            title={overdue ? t('meetings.overdue_title', 'Overdue') : t('meetings.due_title', 'Due date')}
        >
            <CalendarDays className="w-3 h-3" aria-hidden="true" />
            {due}
            {overdue && <span className="font-semibold">· {t('meetings.overdue', 'overdue')}</span>}
        </span>
    );
}

/** Today as "YYYY-MM-DD" in the viewer's timezone. */
function localToday() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
