/**
 * DangerZone — the ONE delete affordance for a Studio thing (Bee Flow
 * Builder redesign, Sep 2026, Track 0.4). Generalises the block at the foot
 * of `Datatables/DatatableDetail.jsx`.
 *
 * Delete is gated on SEEING what depends on the thing, and only then on
 * typing its name. A confirm dialog that only asks "are you sure?" is asking
 * a question the person cannot answer; this one answers it for them first,
 * with the same list the Used-by tab shows (`UsedByTab`), so the two can
 * never disagree about what breaks.
 *
 * ── THE SERVER STAYS THE AUTHORITY ──────────────────────────────────
 * `DELETE` refuses with `409 {code:'in_use', usage}` unless the request says
 * `confirmedBreaking` (server/routes/datatables.js:1636-1663). This
 * component passes `onDelete(confirmedBreaking)` with `true` only when the
 * list ON SCREEN was non-empty and the name was typed against it — the
 * exact confirmation the 409 asks for. If the list was still loading (or
 * failed to load) it passes `false`, so the server does its own check, and
 * a 409 that comes back re-shows the list from the server's payload and
 * asks for the name again. A person never confirms breaking something they
 * were not shown.
 *
 * `onDelete` may surface that 409 either by THROWING an error carrying
 * `.code === 'in_use'` / `.body.usage` (datatablesApi's convention) or by
 * RESOLVING to the payload `{ code: 'in_use', usage }`; both are handled.
 *
 * No window.confirm here, on purpose: it renders as "localhost says" and
 * cannot carry the list.
 */
import { AlertTriangle, Loader2, Trash2 } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import UsedByTab, { adaptUsageRows } from './UsedByTab';
import useTranslation from '../../hooks/useTranslation';

const BTN = 'px-3 py-1.5 rounded-lg text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2';

/**
 * ── THE OTHER HALF OF THE 409: `unchecked` ──────────────────────────
 * A guard answers with two different facts. `usage` is what it FOUND;
 * `unchecked` names the kinds it could not answer for at all. They arrive in
 * one response and lead to the same button, but only the first one is a list,
 * and "I could not check the agents" must never be shown as "no agent uses
 * this" — that empty list is the exact sentence somebody presses through.
 * Callers that carry the kinds pass them in `unchecked`; the card then
 * withholds the "nothing uses this" claim instead of making it. Omitting the
 * prop keeps the previous wording, so no existing caller changes.
 *
 * It applies to a NON-EMPTY list too, and that is the half that is easy to
 * lose. "One thing uses this and will start failing:" over a list of one reads
 * as a COMPLETE list — a found row is the shape in which a reader is most sure
 * they are seeing everything — while `unchecked` may still name two kinds
 * nobody could look at. So the incomplete line is printed in both branches, and
 * only the wording differs.
 */

/** The `usage` rows out of a 409 in_use payload (or an error wrapping one), else null. */
export function inUsePayload(x) {
    if (!x || typeof x !== 'object') return null;
    if (x.code === 'in_use' && Array.isArray(x.usage)) return x.usage;
    if (x.body && typeof x.body === 'object' && x.body.code === 'in_use' && Array.isArray(x.body.usage)) return x.body.usage;
    if (x.status === 409 && x.body && Array.isArray(x.body.usage)) return x.body.usage;
    return null;
}

/**
 * @param {object} props
 * @param {string}     props.entityName      the name the person must type
 * @param {Array|null} props.usage           the shared list: null = not loaded, [] = nothing depends on it
 * @param {(confirmedBreaking: boolean) => Promise<any>|any} props.onDelete
 * @param {string}     [props.kindLabel]     "table", "agent" — for the copy; defaults to a neutral word
 * @param {string|null}[props.currentUserId] forwarded to the list (navigable-vs-plain-text rule)
 * @param {(href: string) => void} [props.onNavigate]
 * @param {(row: any) => object|null} [props.adapt]  legacy row → contract row, for both the list and a 409 payload
 * @param {React.ReactNode} [props.notice]   an extra warning shown inside the armed card (e.g. "rows hold plaintext")
 * @param {string}     [props.openLabel]     the collapsed link's text
 * @param {boolean}    [props.requireName]   always ask for the name, even with no dependents — for a thing
 *                                           that IS data (a table's rows), not just a reference
 * @param {string[]}   [props.unchecked]     kinds the scan could not answer for; suppresses the
 *                                           "nothing uses this" claim (see above)
 * @param {boolean}    [props.defaultArmed]  open on the armed card instead of the collapsed link —
 *                                           for a caller that is already a delete-only surface
 *                                           (a dialog), where the link would be a second click
 *                                           asking the question the surface was opened to ask
 * @param {() => void} [props.onCancel]      called after Cancel has reset the card; a dialog
 *                                           host closes itself here instead of dropping the
 *                                           person back onto the collapsed link
 */
export default function DangerZone({
    entityName,
    usage,
    onDelete,
    kindLabel,
    currentUserId = null,
    onNavigate = null,
    adapt,
    notice = null,
    openLabel,
    requireName = false,
    unchecked = [],
    defaultArmed = false,
    onCancel = null,
    className = '',
    // The question and the confirm word, when "delete for good" is not what
    // happens: unlinking a mirrored table removes a COPY and leaves the source
    // exactly as it is, and a button that says "Delete for good" over that is
    // a threat the product cannot carry out. Defaults are the delete wording.
    question = null,
    confirmLabel = null,
}) {
    const { t } = useTranslation();
    const [armed, setArmed] = useState(defaultArmed);
    const [typed, setTyped] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    // The server's 409 payload, once it has spoken: fresher than the list we
    // were handed, so it wins — but only against the `usage` it answered to.
    // The moment the parent hands us a new list, the conflict is stale by
    // construction (derived during render, no effect needed).
    const [conflict, setConflict] = useState(null); // { base: usage, rows }
    const conflictUsage = conflict && conflict.base === usage ? conflict.rows : null;
    const mounted = useRef(true);
    useEffect(() => () => { mounted.current = false; }, []);

    const known = conflictUsage ?? usage;
    const dependents = known == null ? null : adaptUsageRows(known, adapt);
    const unknown = dependents === null;
    const hasDependents = !unknown && dependents.length > 0;
    // Typing the name is the price of breaking something. Nothing depends
    // on it → the two-step (arm, then confirm) is enough, unless the caller
    // says the thing is data in its own right. Not loaded → we do not know,
    // so ask for the name anyway.
    const needsName = requireName || unknown || hasDependents;
    const nameOk = !needsName || typed === entityName;
    const thing = kindLabel || t('usage.kind_other', 'item');

    const reset = useCallback(() => {
        setArmed(false);
        setTyped('');
        setError(null);
        setBusy(false);
        onCancel?.();
    }, [onCancel]);

    const showConflict = useCallback((rows) => {
        setConflict({ base: usage, rows });
        setTyped('');
        setBusy(false);
        setError(t('usage.in_use_refreshed', 'Something still uses this. The list below is fresh — type the name again to confirm.'));
    }, [t, usage]);

    const del = useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
            const result = await onDelete(hasDependents);
            const conflict = inUsePayload(result);
            if (!mounted.current) return;
            if (conflict) { showConflict(conflict); return; }
            // Success: the parent normally unmounts us. If it did not, do
            // not leave the button spinning forever.
            setBusy(false);
        } catch (e) {
            if (!mounted.current) return;
            const conflict = inUsePayload(e);
            if (conflict) { showConflict(conflict); return; }
            setError(e?.message || t('usage.err_delete', 'Could not delete “{name}”', { name: entityName }));
            setBusy(false);
        }
    }, [onDelete, hasDependents, showConflict, entityName, t]);

    return (
        <div className={`mt-8 pt-5 border-t ${className}`} style={{ borderColor: 'var(--border-subtle)' }} data-testid="danger-zone">
            {!armed ? (
                <button
                    type="button"
                    onClick={() => setArmed(true)}
                    className="text-xs inline-flex items-center gap-1.5 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                    style={{ color: 'var(--error)', outlineColor: 'var(--error)' }}
                >
                    <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                    {openLabel || t('usage.delete_open', 'Delete this {kind}', { kind: thing })}
                </button>
            ) : (
                <div className="rounded-lg border p-4 space-y-3" style={{ borderColor: 'var(--error)' }} role="group" aria-label={t('usage.delete_group', 'Delete')}>
                    <p className="text-sm font-medium flex items-start gap-2" style={{ color: 'var(--text-primary)' }}>
                        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" style={{ color: 'var(--error)' }} aria-hidden="true" />
                        {question || t('usage.delete_question', 'Delete “{name}” for good?', { name: entityName })}
                    </p>

                    {notice}

                    <Dependents t={t} dependents={dependents} unchecked={unchecked} currentUserId={currentUserId} onNavigate={onNavigate} />

                    {needsName && (
                        <label className="block">
                            <span className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>
                                {t('usage.delete_type_name', 'Type the name to confirm.')}
                            </span>
                            <input
                                value={typed}
                                onChange={(e) => setTyped(e.target.value)}
                                aria-label={t('usage.delete_type_name', 'Type the name to confirm.')}
                                placeholder={entityName}
                                autoComplete="off"
                                className="w-full px-3 py-2 rounded-lg text-sm border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1"
                                style={{
                                    background: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)',
                                    color: 'var(--text-primary)', outlineColor: 'var(--accent-primary)',
                                }}
                            />
                        </label>
                    )}

                    <p aria-live="polite">
                        {error && <span className="text-xs" style={{ color: 'var(--warning)' }}>{error}</span>}
                    </p>

                    <div className="flex gap-2">
                        <button
                            type="button"
                            onClick={reset}
                            className={`${BTN} border`}
                            style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)', outlineColor: 'var(--accent-primary)' }}
                        >
                            {t('usage.cancel', 'Cancel')}
                        </button>
                        <button
                            type="button"
                            onClick={del}
                            disabled={busy || !nameOk}
                            className={`${BTN} font-medium text-white disabled:opacity-50 inline-flex items-center gap-1.5`}
                            style={{ background: 'var(--error)', outlineColor: 'var(--error)' }}
                        >
                            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />}
                            {confirmLabel || t('usage.delete_confirm', 'Delete for good')}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

/**
 * What breaks: still checking · the list · nothing found but not everything
 * checked · nothing. Answered before the name is asked.
 */
function Dependents({ t, dependents, unchecked = [], currentUserId, onNavigate }) {
    if (dependents === null) {
        return (
            <p className="text-xs flex items-center gap-2" style={{ color: 'var(--text-secondary)' }} data-testid="danger-checking">
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                {t('usage.checking', 'Checking who uses this…')}
            </p>
        );
    }
    if (dependents.length === 0) {
        // An empty list only means "nothing uses this" when everything was
        // actually looked at. With a kind left unanswered the honest line is
        // the narrower one — the caller's `notice` names which kinds.
        if (unchecked.length > 0) {
            return (
                <p className="text-xs" style={{ color: 'var(--warning)' }} data-testid="danger-unchecked">
                    {t('usage.delete_nothing_found_incomplete', 'Nothing was found — but not everything could be checked, so this is not the same as “nothing uses this”.')}
                </p>
            );
        }
        return (
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }} data-testid="danger-unused">
                {t('usage.delete_nothing_depends', 'Nothing uses this. It can be deleted without breaking anything else.')}
            </p>
        );
    }
    return (
        <div className="space-y-2" data-testid="danger-dependents">
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                {dependents.length === 1
                    ? t('usage.delete_dependents_one', 'One thing uses this and will start failing:')
                    : t('usage.delete_dependents', '{n} things use this and will start failing:', { n: dependents.length })}
            </p>
            <UsedByTab rows={dependents} currentUserId={currentUserId} onNavigate={onNavigate} showSummary={false} />
            {/*
              * A found row does not make the list complete. Without this line
              * the most common state of all — one Solution found, two kinds
              * unanswered — reads as the whole truth.
              */}
            {unchecked.length > 0 && (
                <p className="text-xs" style={{ color: 'var(--warning)' }} data-testid="danger-dependents-incomplete">
                    {t('usage.delete_dependents_incomplete', 'And this list is not the whole story — not everything could be checked.')}
                </p>
            )}
        </div>
    );
}
