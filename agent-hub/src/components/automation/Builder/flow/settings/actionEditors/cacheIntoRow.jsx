// "Remember answers in a table" — the visible half of reusing an answer, a
// separate tick from AskOnceRow and offered on the http_request editor.
import { useMemo } from 'react';
import { inputClass } from '../formPrimitives';

/** Who else can read a table, in the words the datatables list uses. */
const TABLE_AUDIENCE = {
    personal: 'only you',
    org: 'everyone in the organisation',
    groups: 'the groups it is shared with',
};

/**
 * "Remember answers in a table" — the VISIBLE half of reusing an answer.
 *
 * A separate tick from AskOnceRow, not a nested one, because they are separate
 * promises: askOnce reuses an answer inside a run (and, ticked further, out of
 * an encrypted store nobody can read); this one writes the answer into a table
 * the author can open, correct, export and read from another automation. Either
 * can be on alone.
 *
 * THE HELP TEXT IS THE FEATURE. The difference between the two tiers is not
 * discoverable from the behaviour — both make the second call disappear — and
 * the only visible difference is the one that matters: these rows are plain
 * text that colleagues with access to the table can read and export. The
 * audience is on every option for the same reason.
 *
 * The picker offers ONLY tables provisioned for this (`managedKind`
 * 'http_cache'). Their columns are fixed and the runner writes them by name, so
 * pointing this at an ordinary table would fail once, at run time, at 3am.
 */
function CacheIntoRow({ draft, set, catalog = null, disabled = false, disabledReason = null }) {
    const tables = useMemo(() => (catalog?.datatables || [])
        .filter(t => t && t.managedKind === 'http_cache' && t.canWrite !== false), [catalog]);
    const current = (draft.cacheInto && typeof draft.cacheInto === 'object') ? draft.cacheInto : null;
    const on = !!(current && current.datatableId);
    // A tick with nowhere to put the answers would be a setting that reads as
    // configured and does nothing — the exact failure the validator warns about.
    const noTables = tables.length === 0;
    const blocked = disabled || (noTables && !on);
    const reason = disabled
        ? disabledReason
        : (noTables ? 'Make an answers table first — Studio → Datatables → New table → “Web service answers”.' : null);

    const days = Number.isFinite(Number(current?.maxAgeDays)) ? Number(current.maxAgeDays) : 30;
    const setTable = (datatableId) => set('cacheInto', datatableId ? { datatableId, maxAgeDays: days } : undefined);
    const setDays = (value) => {
        const n = Math.round(Number(value));
        if (!current?.datatableId) return;
        set('cacheInto', { datatableId: current.datatableId, ...(Number.isFinite(n) ? { maxAgeDays: n } : {}) });
    };

    return (
        <div className="pt-2 space-y-1.5">
            <label className={`flex items-start gap-2 text-xs ${blocked ? 'opacity-60' : ''}`}>
                <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={on}
                    disabled={blocked}
                    onChange={(e) => setTable(e.target.checked ? (tables[0]?.id || '') : '')}
                />
                <span>
                    <span className="font-medium">Remember answers in a table</span>
                    <span className="block text-slate-500 dark:text-slate-400">
                        {reason || 'Each answer is written to a table as an ordinary row, so a later run — days or weeks on — uses it instead of asking again. You can open the table, check the answers, correct them and export them.'}
                    </span>
                </span>
            </label>

            {on && (
                <div className="pl-5 space-y-2">
                    <label className="block text-xs">
                        <span className="block text-slate-500 dark:text-slate-400 mb-1">Which table</span>
                        <select
                            value={current.datatableId}
                            onChange={(e) => setTable(e.target.value)}
                            className={inputClass()}
                        >
                            {/* A table the step names but this account can no
                                longer see must not vanish from the control:
                                silently re-pointing it at another table is
                                worse than showing that it is gone. */}
                            {!tables.some(t => t.id === current.datatableId) && (
                                <option value={current.datatableId}>
                                    (a table you can no longer reach)
                                </option>
                            )}
                            {tables.map(t => (
                                <option key={t.id} value={t.id}>
                                    {t.name} — readable by {TABLE_AUDIENCE[t.scope] || 'everyone with access'}
                                </option>
                            ))}
                        </select>
                    </label>

                    <label className="block text-xs">
                        <span className="block text-slate-500 dark:text-slate-400 mb-1">Reuse an answer for</span>
                        <span className="flex items-center gap-2">
                            <input
                                type="number"
                                min={1}
                                max={3650}
                                value={days}
                                onChange={(e) => setDays(e.target.value)}
                                className={`${inputClass()} w-24`}
                            />
                            <span className="text-slate-500 dark:text-slate-400">days</span>
                        </span>
                    </label>

                    <div className="text-xs text-slate-500 dark:text-slate-400">
                        {/* The one thing nobody would guess, said where the
                            decision is made rather than buried in a doc: unlike
                            the encrypted store above, these rows are plain text
                            in a table other people can open. */}
                        Answers land as ordinary rows: everyone with access to that table can read and
                        export them. Old rows are removed by the retention window set on the table itself.
                    </div>
                </div>
            )}
        </div>
    );
}

export { CacheIntoRow };
