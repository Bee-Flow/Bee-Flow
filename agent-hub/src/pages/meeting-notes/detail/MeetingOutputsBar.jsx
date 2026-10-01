/**
 * "What happens to this meeting" — the outputs bar under the tag row
 * (Bee Flow Builder redesign, Sep 2026, Track M2).
 *
 * A meeting note is not an endpoint. Its summary is collected into knowledge
 * bases by tag, routines run on it the moment it is ready, and notebooks hold
 * copies. All of that is invisible from the note itself, which is where
 * somebody decides to add a tag, change one, or delete the whole thing.
 *
 * ── ONE DERIVATION, THREE SURFACES ──────────────────────────────────
 * The rows here are the SAME rows the Used-by tab lists and the delete
 * confirmation shows, from the one `useUsage('meeting', id)` fetch that
 * MeetingDetail already makes. Not a second request and not a second
 * opinion: a bar that says a knowledge base collects this meeting while the
 * delete dialog says nothing depends on it is worse than either being
 * absent.
 *
 * ── EMPTY AND UNKNOWN ARE DIFFERENT SENTENCES ───────────────────────
 * `rows === null` is "still checking". A failed read, or a `unchecked` list
 * from the server, is "I could not check X" — said out loud, above the list,
 * never rendered as "nothing happens with this meeting". The bar is the
 * screen that would otherwise quietly claim a meeting is unused right before
 * somebody deletes it.
 *
 * ── WHY A ROUTINE WITH NO FILTER READS AS "EVERY MEETING" ───────────
 * `triggerBus/filters.js` has no meeting-notes matcher yet, so the only
 * meeting-notes filters that fire today are the empty one and the DSL
 * `expr` form. The server marks the first kind with `unfiltered: true` and
 * this bar says so. That is not a placeholder — it is what those routines
 * do.
 */
import { AlertTriangle, ArrowUpRight, Loader2 } from 'lucide-react';
import React, { useMemo } from 'react';
import { kindColorVar, kindIcon } from '../../../components/shared/kindColors';
import { isForeignRow, kindLabelFor, usageHref, usageKind } from '../../../components/shared/UsedByTab';
import useTranslation from '../../../hooks/useTranslation';

/**
 * The rows worth putting in a one-line bar, in a stable order so the chips do
 * not reshuffle between two loads of the same meeting. Knowledge bases first
 * (they change what colleagues can ask), then routines, then notebooks.
 */
const ORDER = Object.freeze(['kb', 'automation', 'notebook']);

export function orderRows(rows) {
    if (!Array.isArray(rows)) return [];
    return rows
        .filter(r => r && typeof r === 'object')
        .map((row, i) => ({ row, i }))
        .sort((a, b) => {
            const ka = ORDER.indexOf(usageKind(a.row));
            const kb = ORDER.indexOf(usageKind(b.row));
            // An unknown kind sorts last rather than first — `indexOf` returns
            // -1, which would otherwise put the thing we understand least at
            // the front of the bar.
            const sa = ka === -1 ? ORDER.length : ka;
            const sb = kb === -1 ? ORDER.length : kb;
            return sa - sb || a.i - b.i;
        })
        .map(({ row }) => row);
}

export default function MeetingOutputsBar({
    rows,
    unchecked = [],
    error = null,
    currentUserId = null,
    onNavigate = null,
    className = '',
}) {
    const { t } = useTranslation();
    const list = useMemo(() => orderRows(rows), [rows]);
    const pending = rows === null || rows === undefined;
    const kinds = Array.isArray(unchecked) ? unchecked.filter(k => typeof k === 'string') : [];

    if (pending) {
        return (
            <p className={`flex items-center gap-1.5 text-[11px] text-[var(--text-tertiary)] ${className}`} data-testid="meeting-outputs-loading">
                <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                {t('meetings.outputs_checking', 'Checking what happens to this meeting…')}
            </p>
        );
    }

    const kindNames = kinds.map(k => kindLabelFor(t, k, 2)).join(', ');
    // One quiet line. What could not be checked comes FIRST, so an incomplete
    // list is never read as a complete one; the full sentence is its tooltip.
    return (
        <div className={`flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-[var(--text-tertiary)] ${className}`} data-testid="meeting-outputs">
            {list.length > 0 && <span>{t('meetings.outputs_title', 'What happens to this meeting')}</span>}
            {error && (
                <span role="status" className="inline-flex items-center gap-1 text-[var(--warning-ink)]"
                    title={t('meetings.outputs_error', 'Could not check what happens to this meeting — this list may be incomplete.')}>
                    <AlertTriangle className="w-3 h-3 shrink-0" aria-hidden="true" />
                    {t('meetings.outputs_error_short', 'Could not check everything')}
                </span>
            )}
            {kinds.length > 0 && (
                <span role="status" className="inline-flex items-center gap-1 text-[var(--warning-ink)]" data-testid="meeting-outputs-unchecked"
                    title={t('meetings.outputs_unchecked', 'Could not check {kinds}, so something may be missing from this list.', { kinds: kindNames })}>
                    <AlertTriangle className="w-3 h-3 shrink-0" aria-hidden="true" />
                    {t('meetings.outputs_unchecked_short', 'Not checked: {kinds}', { kinds: kindNames })}
                </span>
            )}
            {list.length === 0 ? (
                // "Nothing picks this up" only when nothing went unanswered;
                // otherwise the honest claim is the weaker one.
                <span data-testid="meeting-outputs-empty">
                    {(error || kinds.length > 0) && <span aria-hidden="true">· </span>}
                    {error || kinds.length > 0
                        ? t('meetings.outputs_none_known', 'Nothing found so far')
                        : t('meetings.outputs_none', 'Nothing picks this meeting up yet.')}
                </span>
            ) : (
                <div className="contents" role="list" aria-label={t('meetings.outputs_title', 'What happens to this meeting')}>
                    {list.map((row, i) => (
                        <OutputChip
                            key={`${usageKind(row)}:${row.id ?? i}:${row.siteLabel ?? ''}`}
                            row={row}
                            currentUserId={currentUserId}
                            onNavigate={onNavigate}
                            t={t}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

/** Icon + colour for a kind, resolved together — the shape UsedByTab uses. */
function kindVisual(kind) {
    return { Icon: kindIcon(kind), color: kindColorVar(kind) };
}

/**
 * One chip. The navigation rule is UsedByTab's, deliberately re-used rather
 * than re-decided: a row owned by somebody else is PLAIN TEXT that says whose
 * it is, because a colleague's routine has no page this account can open and
 * a link that lands on nothing is worse than no link.
 */
function OutputChip({ row, currentUserId, onNavigate, t }) {
    const kind = usageKind(row);
    const { Icon, color } = kindVisual(kind);
    const href = usageHref(row);
    const foreign = isForeignRow(row, currentUserId);
    const navigable = !foreign && typeof onNavigate === 'function' && !!href;
    const label = kindLabelFor(t, kind, 1);
    const title = row.title
        || (foreign
            ? t('usage.someone_elses_kind', 'Someone else’s {kind}', { kind: label })
            : t('usage.untitled_kind', 'Untitled {kind}', { kind: label }));
    // The server sends a flag or a NUMBER, never a sentence: an English label
    // minted on the server arrives untranslated in every locale.
    //
    // `lineCount` is what tells two chips for the same knowledge base apart —
    // one because it collects everything with this tag, one because somebody
    // filed lines from this transcript into it (M4). Without it they would be
    // two identical chips making two different claims.
    const detail = row.unfiltered
        ? t('meetings.outputs_every_meeting', 'on every meeting')
        : Number.isInteger(row.lineCount) && row.lineCount > 0
            ? (row.lineCount === 1
                ? t('meetings.extracted_lines', '{count} knowledge line', { count: row.lineCount })
                : t('meetings.extracted_lines_plural', '{count} knowledge lines', { count: row.lineCount }))
            : (row.siteLabel || null);

    const body = (
        <>
            {Icon && <Icon style={{ width: 11, height: 11, flexShrink: 0, color }} aria-hidden="true" />}
            <span className="truncate max-w-[160px]">{title}</span>
            {detail && <span className="truncate max-w-[120px] text-[var(--text-tertiary)]">· {detail}</span>}
            {navigable && <ArrowUpRight className="w-2.5 h-2.5 text-[var(--text-tertiary)]" aria-hidden="true" />}
        </>
    );

    const chip = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] bg-[var(--bg-secondary)] border-[var(--border-default)] text-[var(--text-secondary)]';

    return navigable ? (
        <button
            type="button"
            role="listitem"
            data-testid="meeting-output-chip"
            onClick={() => onNavigate(href)}
            className={`${chip} hover:bg-[var(--bg-tertiary)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent-primary)]`}
        >
            {body}
        </button>
    ) : (
        <span
            role="listitem"
            data-testid="meeting-output-chip"
            className={chip}
        >
            {body}
        </span>
    );
}
