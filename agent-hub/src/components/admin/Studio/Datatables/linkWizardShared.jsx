import { Check, Link2, Lock, Plus, X } from 'lucide-react';
import React, { useState } from 'react';

/**
 * What the two link wizards — Nextcloud tables and spreadsheet files — have
 * in common: the step strip in the header, the relations editor, the review
 * list of relations, the audience sentence, the refusal sentences that are
 * not about a source at all, and the handful of style constants a wizard
 * modal is built from.
 *
 * Extracted from LinkNextcloudTablesDialog.jsx when the second wizard came,
 * rather than copied into it: a relations editor is four selects and a
 * sentence, and two copies of it are two places that can disagree about
 * what a relation is.
 *
 * ── COLUMNS ARE `{ id, title, type }`, NOTHING MORE ─────────────────
 * The editor never looks inside a column beyond those three: `id` is what
 * the selects hold and what makes a relation unique, `title` is what a
 * person reads, `type` decides whether the column can be matched at all
 * (MATCHABLE). Each wizard maps its own column shape onto that — the
 * Nextcloud one keeps `ncColumnId` on the object so its wire body is the
 * integer Nextcloud knows; the spreadsheet one keeps `col`. A relation is
 * `{ from: table, localColumn, to: table, targetColumn }` where the tables
 * are the wizard's own selection entries (`refKey`, `name`, `key`, plus
 * whatever the wizard needs to name them on the wire).
 */

/** Column types two tables can be matched on. A date or a checkbox is not an identifier. */
export const MATCHABLE = new Set(['text', 'number', 'select', 'richtext']);

export const INPUT = 'w-full px-3 py-2 rounded-lg text-sm border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1';
export const INPUT_STYLE = { background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)', outlineColor: 'var(--accent-primary)' };
export const BTN = 'px-3 py-2 rounded-[10px] text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2';
export const CARD = { borderRadius: 12, background: 'var(--bg-primary)', border: '1px solid var(--border-default)' };
export const SELECT = `${INPUT} appearance-none`;

/** The refusals a link can answer with that are about the TABLE, not the source. */
export function messageFor(t, err) {
    switch (err?.code) {
        case 'key_taken': return t('datatables.err_key_taken', 'There is already a table with this key. Pick another one.');
        case 'quota_exceeded': return t('datatables.err_quota', 'You have reached the limit on tables here.');
        case 'no_organisation': return t('datatables.err_no_org', 'This account is not in an organisation, so it can only make a personal table.');
        default: return err?.message || t('datatables.err_create', 'Could not create the table');
    }
}

/** A few words in the header: where you are. `labels` are the wizard's own step names. */
export function StepStrip({ t, at, labels }) {
    return (
        <ol className="flex items-center gap-2 text-[11px]" aria-label={t('datatables.nc_steps', 'Steps')}>
            {labels.map((label, i) => (
                <li key={label} className="inline-flex items-center gap-1.5" aria-current={i === at ? 'step' : undefined}
                    style={{ color: i === at ? 'var(--text-primary)' : 'var(--text-tertiary)', fontWeight: i === at ? 600 : 400 }}>
                    <span className="grid place-items-center w-4 h-4 rounded-full text-[10px]"
                        style={{ background: i < at ? 'var(--accent-primary)' : 'var(--bg-secondary)', color: i < at ? '#fff' : 'inherit', border: '1px solid var(--border-default)' }}>
                        {i < at ? <Check className="w-2.5 h-2.5" aria-hidden="true" /> : i + 1}
                    </span>
                    {label}
                </li>
            ))}
        </ol>
    );
}

/** What makes a relation the same relation: both ends, by table and column id. */
export function relKeyOf(r) {
    return `${r.from.refKey}:${r.localColumn.id}>${r.to.refKey}:${r.targetColumn.id}`;
}
export function sameRel(a, b) { return relKeyOf(a) === relKeyOf(b); }

/**
 * Same title in two selected tables — offered, never assumed. `tables` are
 * `{ refKey, name, key, columns:[{id,title,type}] }`; one suggestion per
 * ordered pair, so "A.x matches B.x" and "B.x matches A.x" are both offered
 * (a relation has a direction: which table gets the link column).
 */
export function suggestRelations(tables) {
    const out = [];
    for (let i = 0; i < tables.length; i += 1) {
        for (let j = 0; j < tables.length; j += 1) {
            if (i === j) continue;
            for (const ca of tables[i].columns || []) {
                if (!MATCHABLE.has(ca.type)) continue;
                const cb = (tables[j].columns || []).find(x => MATCHABLE.has(x.type) && String(x.title).toLowerCase() === String(ca.title).toLowerCase());
                if (cb) out.push({ from: tables[i], localColumn: ca, to: tables[j], targetColumn: cb });
            }
        }
    }
    return out;
}

/**
 * The relations editor: the source's own relations (locked), the same-title
 * suggestions (opt-in), the relations the person added, and the four
 * selects to add one more.
 *
 * `locked` entries are `{ key, from:{name}, columnTitle, targetName|null }`
 * — a relation the source declares itself, shown but not editable; the
 * wizard says where they come from with `lockedLabel`.
 */
export function RelationsStep({ t, tables, locked = [], lockedLabel = '', suggestions, relations, hasRel, onAdd, onRemove, intro, needTwo }) {
    const [draft, setDraft] = useState({ from: '', local: '', to: '', target: '' });
    const cols = (s) => ((s && s.columns) || []).filter(c => MATCHABLE.has(c.type));
    const fromSel = tables.find(s => s.refKey === draft.from);
    const toSel = tables.find(s => s.refKey === draft.to);
    const localCol = cols(fromSel).find(c => c.id === draft.local);
    const targetCol = cols(toSel).find(c => c.id === draft.target);
    const complete = fromSel && toSel && localCol && targetCol && fromSel !== toSel;
    const draftRel = complete ? { from: fromSel, localColumn: localCol, to: toSel, targetColumn: targetCol } : null;
    const manual = relations.filter(r => !suggestions.some(sg => sameRel(sg, r)));

    return (
        <div className="space-y-3">
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{intro}</p>
            {tables.length < 2 && (
                <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{needTwo}</p>
            )}
            {locked.map((r) => (
                <div key={r.key} className="flex items-center gap-2 p-2.5 text-sm" style={CARD}>
                    <Lock className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
                    <span className="min-w-0 truncate" style={{ color: 'var(--text-primary)' }}>
                        {r.from.name} · {r.columnTitle} → {r.targetName || t('datatables.nc_rel_unlinked', 'a table not selected')}
                    </span>
                    <span className="ml-auto text-[11px] shrink-0" style={{ color: 'var(--text-tertiary)' }}>{lockedLabel}</span>
                </div>
            ))}
            {suggestions.map((sg) => (
                <label key={relKeyOf(sg)} className="flex items-center gap-2 p-2.5 text-sm cursor-pointer" style={CARD}>
                    <input type="checkbox" checked={hasRel(sg)} onChange={(e) => (e.target.checked ? onAdd(sg) : onRemove(sg))} />
                    <span className="min-w-0 truncate" style={{ color: 'var(--text-primary)' }}>
                        {sg.from.name} · {sg.localColumn.title} {t('datatables.nc_relation_matches', 'matches')} {sg.to.name} · {sg.targetColumn.title}
                    </span>
                    <span className="ml-auto text-[11px] shrink-0" style={{ color: 'var(--text-tertiary)' }}>{t('datatables.nc_relation_suggested', 'same title')}</span>
                </label>
            ))}
            {manual.map((r) => (
                <div key={relKeyOf(r)} className="flex items-center gap-2 p-2.5 text-sm" style={CARD}>
                    <Link2 className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
                    <span className="min-w-0 truncate" style={{ color: 'var(--text-primary)' }}>
                        {r.from.name} · {r.localColumn.title} {t('datatables.nc_relation_matches', 'matches')} {r.to.name} · {r.targetColumn.title}
                    </span>
                    <button type="button" onClick={() => onRemove(r)} className="ml-auto p-1 rounded" aria-label={t('datatables.nc_relation_remove', 'Remove this relation')} style={{ color: 'var(--text-tertiary)' }}>
                        <X className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                </div>
            ))}
            {tables.length >= 2 && (
                <div className="p-3 space-y-2" style={CARD}>
                    <span className="block text-xs font-medium" style={{ color: 'var(--text-primary)' }}>{t('datatables.nc_relation_add', 'Add a relation')}</span>
                    <div className="grid gap-2 items-center" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) auto minmax(0,1fr) minmax(0,1fr)' }}>
                        <select value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value, local: '' })} className={SELECT} style={INPUT_STYLE} aria-label={t('datatables.nc_rel_from', 'Table')}>
                            <option value="">{t('datatables.nc_rel_from', 'Table')}</option>
                            {tables.map(s => <option key={s.refKey} value={s.refKey}>{s.name}</option>)}
                        </select>
                        <select value={draft.local} onChange={(e) => setDraft({ ...draft, local: e.target.value })} className={SELECT} style={INPUT_STYLE} aria-label={t('datatables.nc_rel_column', 'Column')} disabled={!fromSel}>
                            <option value="">{t('datatables.nc_rel_column', 'Column')}</option>
                            {cols(fromSel).map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
                        </select>
                        <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('datatables.nc_relation_matches', 'matches')}</span>
                        <select value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value, target: '' })} className={SELECT} style={INPUT_STYLE} aria-label={t('datatables.nc_rel_to', 'Other table')}>
                            <option value="">{t('datatables.nc_rel_to', 'Other table')}</option>
                            {tables.filter(s => s.refKey !== draft.from).map(s => <option key={s.refKey} value={s.refKey}>{s.name}</option>)}
                        </select>
                        <select value={draft.target} onChange={(e) => setDraft({ ...draft, target: e.target.value })} className={SELECT} style={INPUT_STYLE} aria-label={t('datatables.nc_rel_target_column', 'Its column')} disabled={!toSel}>
                            <option value="">{t('datatables.nc_rel_target_column', 'Its column')}</option>
                            {cols(toSel).map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
                        </select>
                    </div>
                    {draftRel && (
                        <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                            {t('datatables.nc_relation_sentence', 'Each row of {a} gets a link to the row of {b} whose {y} equals its {x}. The link column will be called {key}.',
                                { a: fromSel.name, b: toSel.name, x: localCol.title, y: targetCol.title, key: `${toSel.key}_ref` })}
                        </p>
                    )}
                    <button type="button" disabled={!draftRel || hasRel(draftRel)} onClick={() => { onAdd(draftRel); setDraft({ from: '', local: '', to: '', target: '' }); }}
                        className="text-xs inline-flex items-center gap-1.5 rounded disabled:opacity-50" style={{ color: 'var(--text-secondary)' }}>
                        <Plus className="w-3.5 h-3.5" aria-hidden="true" /> {t('datatables.nc_relation_use', 'Use this relation')}
                    </button>
                </div>
            )}
        </div>
    );
}

/** The relations as the review step lists them: the source's own first, then the person's. */
export function ReviewRelations({ t, locked = [], relations }) {
    if (locked.length + relations.length === 0) return null;
    return (
        <ul className="space-y-1">
            {locked.map(r => (
                <li key={r.key} className="text-xs flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
                    <Lock className="w-3 h-3" aria-hidden="true" />{r.from.name} · {r.columnTitle} → {r.targetName}
                </li>
            ))}
            {relations.map(r => (
                <li key={relKeyOf(r)} className="text-xs flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
                    <Link2 className="w-3 h-3" aria-hidden="true" />{r.from.name} · {r.localColumn.title} {t('datatables.nc_relation_matches', 'matches')} {r.to.name} · {r.targetColumn.title}
                </li>
            ))}
        </ul>
    );
}

/** Whose the tables will be — with the one word that takes the person back to change it. */
export function AudienceLine({ t, scope, onChange }) {
    return (
        <p style={{ color: 'var(--text-secondary)' }}>
            {scope === 'personal'
                ? t('datatables.nc_review_personal', 'These tables will belong to this account only.')
                : t('datatables.nc_review_org', 'These tables will belong to your organisation.')}{' '}
            <button type="button" onClick={onChange} className="underline" style={{ color: 'var(--text-primary)' }}>{t('datatables.nc_review_change', 'Change')}</button>
        </p>
    );
}
