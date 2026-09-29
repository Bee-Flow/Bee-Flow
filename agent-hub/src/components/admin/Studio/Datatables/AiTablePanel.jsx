import { Loader2, ShieldCheck, Sparkles, Undo2 } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { datatablesApi } from './datatablesApi';
import useTranslation from '../../../../hooks/useTranslation';
import { PRIMARY_ACTION_STYLE } from '../../../shared/StudioSectionHeader';

/**
 * "Build it with AI" for a table — one card, two homes.
 *
 * `mode="create"` sits in the New datatable dialog: a brief in (a sentence,
 * or the header row of a spreadsheet, a list of things to track), and the
 * name, the purpose and the columns of the dialog are filled in. Nothing is
 * created until the person presses Create.
 *
 * `mode="revise"` sits above the column designer of an existing table: a
 * request in ("add a phone number", "rename Stage to Status"), the current
 * columns travel along, and the draft lands in the designer's UNSAVED list.
 * Saving is the designer's own step — behind its own confirmation, which
 * names the row count and the automations that read a column before one
 * goes.
 *
 * ── The guard ────────────────────────────────────────────────────────────
 * "Allow removing or retyping columns" is OFF unless the person switches it
 * on for this one request. Off, the server puts back any column the model
 * left out and keeps the type of any column it changed — and says so in
 * the line under the box. A kept column always keeps its KEY (where its
 * rows live); a rename moves only the label. So the worst a misread request
 * can do with the guard on is add columns and rename labels, and even that
 * is one Undo away and unsaved.
 */
const BTN = 'px-3 py-2 rounded-[10px] text-sm border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 disabled:opacity-50';

function errorText(t, err) {
    const code = err?.code;
    if (code === 'no_model') return t('datatables.ai_err_no_model', 'No AI model is set up for this workspace yet.');
    if (code === 'ai_unusable') return t('datatables.ai_err_unusable', 'The AI did not return a usable table. Try again, or describe it more concretely.');
    if (code === 'schema_locked') return t('datatables.ai_err_locked', 'The columns of this table are not yours to change here.');
    if (code === 'no_brief' || code === 'no_note') return t('datatables.ai_err_no_text', 'Type or paste something first.');
    if (err?.status === 429) return t('datatables.ai_err_rate', 'Too many drafts in a minute — wait a moment and try again.');
    return err?.message || t('datatables.ai_err_failed', 'Could not draft the columns.');
}

/** "2 added · 1 renamed · 1 retyped · 1 removed", only the parts that happened. */
function changesText(t, changes) {
    if (!changes) return '';
    const parts = [];
    const n = (arr) => (Array.isArray(arr) ? arr.length : 0);
    if (n(changes.added)) parts.push(t('datatables.ai_changes_added', '{n} added', { n: n(changes.added) }));
    if (n(changes.renamed)) parts.push(t('datatables.ai_changes_renamed', '{n} renamed', { n: n(changes.renamed) }));
    if (n(changes.retyped)) parts.push(t('datatables.ai_changes_retyped', '{n} retyped', { n: n(changes.retyped) }));
    if (n(changes.removed)) parts.push(t('datatables.ai_changes_removed', '{n} removed', { n: n(changes.removed) }));
    return parts.join(' · ');
}

export default function AiTablePanel({ mode = 'create', current = null, onApply, compact = false, testId = 'table-ai' }) {
    const { t } = useTranslation();
    const revise = mode === 'revise';
    const [text, setText] = useState('');
    const [allowDestructive, setAllowDestructive] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [result, setResult] = useState(null); // { count, notes, changes, before }
    const alive = useRef(true);
    useEffect(() => () => { alive.current = false; }, []);

    const run = useCallback(async () => {
        const value = text.trim();
        if (!value || busy) return;
        setBusy(true);
        setError(null);
        try {
            const body = revise
                ? { mode: 'revise', note: value, current, allowDestructive }
                : { mode: 'create', brief: value, current };
            const res = await datatablesApi.draft(body);
            if (!alive.current) return;
            const draft = res?.draft;
            if (!draft || !Array.isArray(draft.fields)) throw Object.assign(new Error('unusable'), { code: 'ai_unusable' });
            const before = current ? JSON.parse(JSON.stringify(current)) : null;
            onApply(draft);
            setResult({ count: draft.fields.length, notes: draft.notes || null, changes: draft.changes || null, before });
            setText('');
            // The guard is per request: the next one starts guarded again.
            setAllowDestructive(false);
        } catch (err) {
            if (alive.current) setError(errorText(t, err));
        } finally {
            if (alive.current) setBusy(false);
        }
    }, [text, busy, revise, current, allowDestructive, onApply, t]);

    const undo = () => {
        if (!result?.before) return;
        onApply({ ...result.before, undo: true });
        setResult(null);
    };

    const summary = result ? [
        revise
            ? changesText(t, result.changes) || t('datatables.ai_done_none', 'Nothing changed.')
            : t('datatables.ai_done_create', '{count} columns drafted — check them below, then Create.', { count: result.count }),
        result.notes,
    ].filter(Boolean).join(' ') : null;

    return (
        <section className={`rounded-xl border ${compact ? 'p-3 space-y-2' : 'p-4 space-y-3'}`}
            style={{ borderColor: 'var(--border-default)', background: 'var(--bg-card)' }} aria-labelledby={`${testId}-title`} data-testid={testId}>
            <div className="flex items-start gap-2">
                <Sparkles className="w-4 h-4 mt-0.5 shrink-0" style={{ color: 'var(--accent-primary)' }} aria-hidden="true" />
                <div className="min-w-0 flex-1">
                    <h3 id={`${testId}-title`} className="text-sm font-semibold m-0" style={{ color: 'var(--text-primary)' }}>{t('datatables.ai_title', 'Build it with AI')}</h3>
                    <p className="text-xs mt-0.5 m-0" style={{ color: 'var(--text-secondary)' }}>
                        {revise
                            ? t('datatables.ai_intro_revise', 'Say what should change. Columns you keep stay as they are — and so do their rows. Nothing is saved until you press Save.')
                            : t('datatables.ai_intro', 'Describe what the rows should hold, or paste what the columns should be based on — a spreadsheet’s header row, an e-mail, a list. The fields below are filled in for you to check.')}
                    </p>
                </div>
            </div>
            <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); } }}
                rows={revise ? 2 : (compact ? 2 : 4)}
                // The server's limits (core/dataEngine/dataModel/datatableDraft:
                // MAX_NOTE_CHARS, MAX_BRIEF_CHARS). A box that took more than the
                // server accepts let someone type a request that could only fail.
                maxLength={revise ? 2000 : 12000}
                placeholder={revise
                    ? t('datatables.ai_placeholder_revise', 'e.g. add a phone number, rename Stage to Status, make Amount required')
                    : t('datatables.ai_placeholder', 'e.g. Supplier invoices: supplier, invoice number, date, amount excl. VAT, VAT %, total, status (new / approved / rejected)')}
                disabled={busy}
                className="w-full px-3 py-2 rounded-lg text-sm border outline-none focus:ring-2 disabled:opacity-60"
                style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                aria-label={t('datatables.ai_title', 'Build it with AI')}
                data-testid={`${testId}-text`}
            />
            {revise && (
                <label className="flex items-start gap-2 text-xs cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
                    <input type="checkbox" className="mt-0.5" checked={allowDestructive} onChange={(e) => setAllowDestructive(e.target.checked)} disabled={busy} data-testid={`${testId}-allow`} />
                    <span>
                        <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{t('datatables.ai_allow', 'Allow removing or retyping columns for this request')}</span>
                        <span className="block" style={{ color: 'var(--text-tertiary)' }}>
                            {t('datatables.ai_allow_help', 'Off, the AI can only add columns and rename them; a column it leaves out is put back. On, a removed or retyped column still asks you before it is saved — and names the rows it costs.')}
                        </span>
                    </span>
                </label>
            )}
            <div className="flex flex-wrap items-center gap-2">
                {error && <span role="alert" className="text-xs mr-auto" style={{ color: 'var(--error)' }}>{error}</span>}
                {!error && summary && (
                    <span className="text-xs mr-auto inline-flex items-start gap-1.5" style={{ color: 'var(--success-ink)' }} role="status" data-testid={`${testId}-done`}>
                        <ShieldCheck className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden="true" />
                        <span>{summary}</span>
                    </span>
                )}
                {result?.before && (
                    <button type="button" onClick={undo} disabled={busy} className={`${BTN} inline-flex items-center gap-1.5`} style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)', outlineColor: 'var(--accent-primary)' }} data-testid={`${testId}-undo`}>
                        <Undo2 className="w-3.5 h-3.5" aria-hidden="true" />{t('datatables.ai_undo', 'Undo')}
                    </button>
                )}
                <button
                    type="button"
                    onClick={run}
                    disabled={busy || !text.trim()}
                    className={`${BTN} font-medium inline-flex items-center gap-1.5 ml-auto`}
                    style={{ ...PRIMARY_ACTION_STYLE, borderColor: 'transparent', outlineColor: 'var(--accent-primary)' }}
                    data-testid={`${testId}-run`}
                >
                    {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />}
                    {busy ? t('datatables.ai_running', 'Drafting…') : (revise ? t('datatables.ai_run_revise', 'Change the columns') : t('datatables.ai_run', 'Draft the columns'))}
                </button>
            </div>
        </section>
    );
}
