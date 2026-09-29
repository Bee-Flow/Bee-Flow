import { History, Loader2, ShieldAlert, Timer } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { ColumnKindIcon } from './ColumnKind';
import { columnLabel, columnTypeKind, expiringSoonCutoffIso } from './datatableDisplay';
import { datatablesApi } from './datatablesApi';
import useTranslation from '../../../../hooks/useTranslation';
import SegmentedControl from '../../../shared/SegmentedControl';
import { PRIMARY_ACTION_STYLE } from '../../../shared/StudioSectionHeader';

/**
 * How long the rows are kept, and what that means (Datatables artboard 1f,
 * "Tab · Bewaartermijn").
 *
 * ── THE WINDOW AND THE COLUMN TRAVEL TOGETHER ───────────────────────
 * `PATCH /:id` REFUSES a non-null `retentionDays` that does not name a
 * `retentionField` in the same request (`retention_field_required`), and it
 * is right to: a window that silently inherits a default is one submission
 * away from deleting rows on a rule nobody chose. So the picker is not a
 * nicety next to the segmented control — it is the other half of the same
 * setting, and this panel never sends one without the other.
 *
 * On a MANAGED table the column is not the author's to pick: the http_cache
 * contract stamps `fetched_at`, and that is the only date the sweep can
 * count from. The picker is shown, disabled, saying so.
 *
 * ── "WHAT IS ABOUT TO GO" IS COUNTED, NOT ESTIMATED ─────────────────
 * The rows route answers `total` as the TABLE's row count, not the filtered
 * one, so a filtered `total` would report the whole table as expiring. The
 * card asks for a page of matching rows instead and counts what comes back,
 * saying "500+" rather than a number it cannot stand behind when there are
 * more than one page of them.
 *
 * The three sentences below the cards are the ones the read-only version of
 * this tab carried, and they stay: what the rows hold (managed tables), that
 * the window IS the whole expiry story for a cache, and that a run keeps its
 * own copy in the run history — the one people are surprised by.
 */

const PRESETS = [7, 30, 90];
/** The server's own cap (`MAX_RETENTION_DAYS`); anything past it is a 400. */
const MAX_DAYS = 3650;
/** How far ahead "about to expire" looks. */
const SOON_DAYS = 7;
/** One page, so the count is a real count. Mirrors the route's ROWS_PAGE_MAX. */
const COUNT_LIMIT = 500;

export default function RetentionPanel({ table, canEdit, columns = [], onChanged }) {
    const { t } = useTranslation();
    const managed = !!table.managedKind;
    const [days, setDays] = useState(table.retentionDays ?? null);
    const [field, setField] = useState(table.retentionField || defaultField(table, columns));
    const [custom, setCustom] = useState(!!table.retentionDays && !PRESETS.includes(table.retentionDays));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [note, setNote] = useState(null);

    // The table object is replaced on every refresh, so the panel follows the
    // server rather than holding a stale draft after somebody else's save.
    const retentionKey = `${table.id}:${table.retentionDays ?? ''}:${table.retentionField ?? ''}`;
    const [seenRetention, setSeenRetention] = useState(retentionKey);
    if (seenRetention !== retentionKey) {
        setSeenRetention(retentionKey);
        setDays(table.retentionDays ?? null);
        setField(table.retentionField || defaultField(table, columns));
        setCustom(!!table.retentionDays && !PRESETS.includes(table.retentionDays));
    }

    const dateColumns = (columns || []).filter(c => c && (c.type === 'date' || c.type === 'datetime'));
    // The schema arrives AFTER the first render, so a field seeded from an
    // empty column list would stay empty and the panel would send
    // `retentionField: ''` — a 400 the person cannot act on. Derived rather
    // than re-seeded so an explicit choice always wins over the default.
    const effectiveField = field || defaultField(table, columns);
    const fieldLabel = labelOf(t, columns, table.retentionField || effectiveField);

    const save = useCallback(async (nextDays, nextField) => {
        setBusy(true);
        setError(null);
        setNote(null);
        try {
            // Both halves, always — see the docblock. `null` turns the window
            // off, and then the column is not part of the question.
            const patch = nextDays === null
                ? { retentionDays: null }
                : { retentionDays: nextDays, retentionField: nextField };
            await datatablesApi.update(table.id, patch);
            setNote(nextDays === null
                ? t('datatables.retention_saved_off', 'Rows are kept until something deletes them.')
                : t('datatables.retention_saved', 'Saved. Rows are deleted {n} days after their {field}.', { n: nextDays, field: labelOf(t, columns, nextField) }));
            onChanged?.();
        } catch (e) {
            setError(e.code === 'retention_field_required'
                ? t('datatables.retention_field_required', 'Pick the date column the age is measured from.')
                : (e.message || t('datatables.err_retention', 'Could not change the retention window')));
        } finally {
            setBusy(false);
        }
    }, [table.id, columns, onChanged, t]);

    const choose = (value) => {
        if (value === 'custom') { setCustom(true); return; }
        if (value === 'off') { setCustom(false); setDays(null); save(null); return; }
        setCustom(false);
        setDays(value);
        // Never send a window without the column it counts from — the server
        // refuses it, and rightly.
        if (!effectiveField) {
            setError(t('datatables.retention_field_required', 'Pick the date column the age is measured from.'));
            return;
        }
        save(value, effectiveField);
    };

    const canPickField = canEdit && !managed && dateColumns.length > 0;

    return (
        <div className="space-y-3">
            {managed && (
                <p className="flex items-start gap-2 text-xs"
                    style={{ padding: '8px 12px', borderRadius: 8, background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}>
                    <ShieldAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: 'var(--warning)' }} aria-hidden="true" />
                    {/* The same sentence managedTables.js MANAGED_KINDS
                        .http_cache.warning states on create, kept as a
                        translated key so a Dutch workspace reads it in Dutch —
                        the server's copy is English-only. */}
                    <span>{t('datatables.managed_plaintext', 'Rows here hold what a third-party service answered, in plain text, readable and exportable by everyone with access to this table.')}</span>
                </p>
            )}

            <div className="grid gap-3 md:grid-cols-2">
                <section style={CARD} className="p-4 flex flex-col gap-2.5">
                    <h3 className="flex items-center gap-2 text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                        <Timer className="w-3.5 h-3.5" style={{ color: 'var(--text-secondary)' }} aria-hidden="true" />
                        {t('datatables.retention_title', 'Rows are deleted after')}
                    </h3>

                    <div className="self-start">
                        <SegmentedControl
                            size="sm"
                            ariaLabel={t('datatables.retention_title', 'Rows are deleted after')}
                            disabled={!canEdit || busy}
                            value={custom ? 'custom' : (days ?? 'off')}
                            onChange={choose}
                            options={[
                                { value: 'off', label: t('datatables.retention_never', 'Never') },
                                ...PRESETS.map(d => ({ value: d, label: t('datatables.retention_days', '{n} days', { n: d }) })),
                                { value: 'custom', label: t('datatables.retention_other', 'Other…') },
                            ]}
                        />
                    </div>

                    {custom && (
                        <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                            <span>{t('datatables.retention_custom_label', 'Days')}</span>
                            <input
                                type="number"
                                min={1}
                                max={MAX_DAYS}
                                value={days ?? ''}
                                disabled={!canEdit || busy}
                                onChange={(e) => setDays(e.target.value === '' ? null : Number(e.target.value))}
                                className="w-24 px-2 py-1 rounded border text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1"
                                style={CONTROL}
                            />
                            <button
                                type="button"
                                disabled={!canEdit || busy || !days || days < 1 || days > MAX_DAYS || !effectiveField}
                                onClick={() => save(days, effectiveField)}
                                className="text-xs px-2.5 py-1 rounded-lg font-medium disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                                style={{ ...PRIMARY_ACTION_STYLE, outlineColor: 'var(--accent-primary)' }}
                            >
                                {t('datatables.retention_apply', 'Apply')}
                            </button>
                        </label>
                    )}

                    <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                        <span className="shrink-0">{t('datatables.retention_counted_from', 'Counted from')}</span>
                        <span className="relative inline-flex items-center gap-1.5">
                            <ColumnKindIcon kind={columnTypeKind('datetime')} size={13}
                                style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                            <select
                                value={effectiveField || ''}
                                disabled={!canPickField || busy}
                                aria-label={t('datatables.retention_field', 'Date column the age is measured from')}
                                onChange={(e) => { setField(e.target.value); if (table.retentionDays) save(table.retentionDays, e.target.value); }}
                                className="px-2 py-1 rounded border text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1"
                                style={CONTROL}
                            >
                                {!effectiveField && <option value="">{t('datatables.retention_pick_field', 'Pick a date column…')}</option>}
                                {managed
                                    ? <option value={table.retentionField || 'fetched_at'}>{fieldLabel}</option>
                                    : dateColumns.map(c => <option key={c.key} value={c.key}>{columnLabel(c)}</option>)}
                            </select>
                        </span>
                    </label>

                    {!managed && dateColumns.length === 0 && (
                        <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                            {t('datatables.retention_no_date_column', 'This table has no date column yet, so there is nothing to count an age from. Add one on the Columns tab first.')}
                        </p>
                    )}

                    <p className="text-xs leading-[18px]" style={{ color: 'var(--text-secondary)' }}>
                        {table.retentionDays
                            ? t('datatables.retention_on', 'Rows are deleted {n} days after their {field}.', { n: table.retentionDays, field: fieldLabel })
                            : t('datatables.retention_off', 'Rows stay until something deletes them — an automation step, or you.')}
                        {/* `!!` because a bare `&&` on a number renders the number. */}
                        {managed && !!table.retentionDays && (
                            <> {t('datatables.retention_managed', 'For this table that window is the whole expiry story: it is what makes a remembered answer go stale, so an automation asks the service again. There is no second, hidden clock.')}</>
                        )}
                    </p>

                    {table.lastRetentionAt && (
                        <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                            {t('datatables.retention_last_run', 'Last swept {when}.', { when: String(table.lastRetentionAt).slice(0, 16).replace('T', ' ') })}
                        </p>
                    )}

                    <p aria-live="polite" className="text-[11px]">
                        {error && <span style={{ color: 'var(--warning)' }}>{error}</span>}
                        {!error && note && <span style={{ color: 'var(--text-secondary)' }}>{note}</span>}
                    </p>
                </section>

                <ExpiringSoon t={t} table={table} columns={columns} />
            </div>
        </div>
    );
}

const CARD = {
    borderRadius: 12,
    background: 'var(--bg-card)',
    border: '1px solid var(--border-default)',
    boxShadow: 'var(--shadow-sm)',
};
const CONTROL = {
    background: 'var(--bg-primary)', borderColor: 'var(--border-default)',
    color: 'var(--text-primary)', outlineColor: 'var(--accent-primary)',
};

/** The column a new window would count from, when the table has an obvious one. */
function defaultField(table, columns) {
    if (table.managedKind === 'http_cache') return 'fetched_at';
    const dates = (columns || []).filter(c => c && (c.type === 'date' || c.type === 'datetime'));
    return dates[0]?.key || '';
}

function labelOf(t, columns, key) {
    if (!key) return t('datatables.retention_no_field', 'no column');
    const hit = (columns || []).find(c => c && c.key === key);
    return hit?.name || key;
}

/**
 * How much is about to go — the number that turns a retention setting from a
 * policy into a decision.
 */
function ExpiringSoon({ t, table, columns }) {
    const [state, setState] = useState({ loading: true, count: 0, more: false, failed: false });
    const { retentionDays, retentionField } = table;

    useEffect(() => {
        if (!retentionDays || !retentionField) {
            setState({ loading: false, count: 0, more: false, failed: false });
            return undefined;
        }
        let alive = true;
        setState(s => ({ ...s, loading: true, failed: false }));
        datatablesApi.listRows(table.id, {
            limit: COUNT_LIMIT,
            filters: [{ field: retentionField, op: 'lte', value: expiringSoonCutoffIso(retentionDays, SOON_DAYS) }],
        })
            .then((body) => {
                if (!alive) return;
                setState({ loading: false, count: (body?.rows || []).length, more: !!body?.hasMore, failed: false });
            })
            // A failed count must not read as "nothing expires": say it could
            // not be worked out.
            .catch(() => { if (alive) setState({ loading: false, count: 0, more: false, failed: true }); });
        return () => { alive = false; };
    }, [table.id, retentionDays, retentionField]);

    const off = !retentionDays || !retentionField;

    return (
        <section style={CARD} className="p-4 flex flex-col gap-2.5">
            <h3 className="flex items-center gap-2 text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                <History className="w-3.5 h-3.5" style={{ color: 'var(--text-secondary)' }} aria-hidden="true" />
                {t('datatables.expiring_title', 'About to expire')}
            </h3>

            <div aria-live="polite">
                {off ? (
                    // The same big figure as a live window, dimmed: "0 rows —
                    // nothing expires on its own" (2c), not a sentence where a
                    // number is expected.
                    <p className="flex items-baseline gap-2 m-0">
                        <span className="text-[24px] font-semibold" style={{ color: 'var(--text-tertiary)' }}>0</span>
                        <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                            {t('datatables.expiring_none_set', 'rows — nothing expires on its own')}
                        </span>
                    </p>
                ) : state.loading ? (
                    <p className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                        {t('datatables.loading', 'Loading…')}
                    </p>
                ) : state.failed ? (
                    <p className="text-xs" style={{ color: 'var(--warning)' }}>
                        {t('datatables.expiring_failed', 'Could not work out what is about to expire.')}
                    </p>
                ) : (
                    <p className="flex items-baseline gap-2">
                        <span className="text-[24px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                            {state.more
                                ? t('datatables.expiring_at_least', '{n}+', { n: state.count })
                                : new Intl.NumberFormat().format(state.count)}
                        </span>
                        <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                            {t('datatables.expiring_body', 'rows expire in the next {n} days', { n: SOON_DAYS })}
                        </span>
                    </p>
                )}
            </div>

            {/* Named here rather than left for a support ticket: erasing a row
                does not reach the copy a run made of it. */}
            <p className="text-[11px] leading-[18px]" style={{ color: 'var(--text-tertiary)' }}>
                {t('datatables.retention_runs', 'A run that read these rows keeps its own copy in its run history, which ages out on the run-history window instead.')}
            </p>
            {!off && (
                <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                    {t('datatables.expiring_counted_from', 'Counted from {field}.', { field: labelOf(t, columns, retentionField) })}
                </p>
            )}
        </section>
    );
}
