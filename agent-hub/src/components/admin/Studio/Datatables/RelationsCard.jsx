import { Link2, Loader2, Lock, Plus, X } from 'lucide-react';
import React, { useEffect, useEffectEvent, useState } from 'react';
import { isSourceMirror, sourceErrorMessage, sourceNameOf } from './datatableDisplay';
import { datatablesApi } from './datatablesApi';

/**
 * The relations a mirror carries, and the editor for the ones declared
 * here ("column X of this table matches column Y of that one"). Nextcloud's
 * own relation columns are shown locked — they are read off the source and
 * cannot be changed from this side.
 *
 * Shared by both mirror kinds, and a relation may CROSS kinds: a spreadsheet
 * of invoices can match a Nextcloud table of suppliers. So the candidate
 * targets are every OTHER mirror in the same scope, whatever it mirrors — the
 * server refuses a cross-scope one, and only mirrors keep the target's row
 * ids stable enough to link to.
 */
export default function RelationsCard({ t, table, mirror, canEdit, onRefresh }) {
    const source = mirror?.source || null;
    const [schema, setSchema] = useState([]);
    const [siblings, setSiblings] = useState([]);
    const [targetSchemas, setTargetSchemas] = useState(() => new Map());
    const [draft, setDraft] = useState({ localFieldId: '', targetDatatableId: '', targetFieldId: '' });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [saved, setSaved] = useState(false);

    useEffect(() => {
        let alive = true;
        datatablesApi.getSchema(table.id).then(s => { if (alive) setSchema(s?.fields || []); }).catch(() => {});
        datatablesApi.list().then(b => {
            if (!alive) return;
            const rows = (b?.datatables || []).filter(x => isSourceMirror(x) && x.id !== table.id && x.scopeKind === table.scopeKind);
            setSiblings(rows);
        }).catch(() => {});
        return () => { alive = false; };
    }, [table.id, table.scopeKind]);

    const relations = source?.relations || [];
    const needTargets = [...new Set([...relations.map(r => r.targetDatatableId), draft.targetDatatableId].filter(Boolean))];
    const needTargetsKey = needTargets.join(',');
    // The id list is rebuilt every render; its joined key drives the effect.
    const loadMissingSchemas = useEffectEvent((isAlive) => {
        for (const id of needTargets) {
            if (targetSchemas.has(id)) continue;
            datatablesApi.getSchema(id)
                .then(s => { if (isAlive()) setTargetSchemas(m => new Map(m).set(id, s?.fields || [])); })
                .catch(() => { if (isAlive()) setTargetSchemas(m => new Map(m).set(id, [])); });
        }
    });
    useEffect(() => {
        let alive = true;
        loadMissingSchemas(() => alive);
        return () => { alive = false; };
    }, [needTargetsKey, targetSchemas]);

    const fieldName = (fields, id) => (fields || []).find(f => f.id === id)?.name || id;
    const siblingName = (id) => siblings.find(s => s.id === id)?.name || id;
    const own = schema.filter(f => !f.derived && f.type !== 'relation');
    const targetFields = (targetSchemas.get(draft.targetDatatableId) || []).filter(f => !f.derived && ['text', 'number', 'select', 'richtext'].includes(f.type));
    const declared = relations.filter(r => r.kind === 'match');
    const complete = draft.localFieldId && draft.targetDatatableId && draft.targetFieldId;

    const save = async (next) => {
        setBusy(true); setError(null); setSaved(false);
        try {
            await mirror.setRelations(next.map(r => ({ targetDatatableId: r.targetDatatableId, localFieldId: r.localFieldId, targetFieldId: r.targetFieldId })));
            setSaved(true);
            setDraft({ localFieldId: '', targetDatatableId: '', targetFieldId: '' });
        } catch (e) { setError(sourceErrorMessage(t, e, table) || e.message); } finally { setBusy(false); }
    };

    return (
        <section className="p-4 space-y-3" style={CARD} aria-label={t('datatables.nc_relations_title', 'Relations')}>
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{t('datatables.nc_relations_title', 'Relations')}</h3>
            {!relations.length && (
                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    {t('datatables.src_relations_empty', 'No relations yet. Link a second table from {source}, or another source, and match a column of each.', { source: sourceNameOf(table, source) })}
                </p>
            )}
            <ul className="space-y-1.5">
                {relations.map((r) => (
                    <li key={r.fieldId} className="flex items-center gap-2 text-sm p-2.5 rounded-lg" style={{ background: 'var(--bg-secondary)' }}>
                        {r.kind === 'nc'
                            ? <Lock className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
                            : <Link2 className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />}
                        <span className="min-w-0 truncate" style={{ color: 'var(--text-primary)' }}>
                            {fieldName(schema, r.fieldId)} → {siblingName(r.targetDatatableId)}
                        </span>
                        <span className="ml-auto text-[11px] shrink-0" style={{ color: 'var(--text-tertiary)' }}>
                            {r.kind === 'nc'
                                ? t('datatables.nc_relation_from_nc', 'from Nextcloud')
                                : t('datatables.nc_relation_matched_on', 'matched on {local} = {target}', { local: fieldName(schema, r.localFieldId), target: fieldName(targetSchemas.get(r.targetDatatableId), r.targetFieldId) })}
                        </span>
                        {canEdit && r.kind === 'match' && (
                            <button type="button" disabled={busy} onClick={() => save(declared.filter(x => x.fieldId !== r.fieldId))}
                                className="p-1 rounded shrink-0" aria-label={t('datatables.nc_relation_remove', 'Remove this relation')} style={{ color: 'var(--text-tertiary)' }}>
                                <X className="w-3.5 h-3.5" aria-hidden="true" />
                            </button>
                        )}
                    </li>
                ))}
            </ul>
            {canEdit && siblings.length > 0 && (
                <div className="space-y-2">
                    <span className="block text-xs font-medium" style={{ color: 'var(--text-primary)' }}>{t('datatables.nc_relation_add', 'Add a relation')}</span>
                    <div className="grid gap-2 items-center" style={{ gridTemplateColumns: 'minmax(0,1fr) auto minmax(0,1fr) minmax(0,1fr)' }}>
                        <select value={draft.localFieldId} onChange={(e) => setDraft({ ...draft, localFieldId: e.target.value })} className={SELECT} style={INPUT_STYLE} aria-label={t('datatables.nc_rel_column', 'Column')}>
                            <option value="">{t('datatables.nc_rel_column', 'Column')}</option>
                            {own.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                        </select>
                        <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('datatables.nc_relation_matches', 'matches')}</span>
                        <select value={draft.targetDatatableId} onChange={(e) => setDraft({ ...draft, targetDatatableId: e.target.value, targetFieldId: '' })} className={SELECT} style={INPUT_STYLE} aria-label={t('datatables.nc_rel_to', 'Other table')}>
                            <option value="">{t('datatables.nc_rel_to', 'Other table')}</option>
                            {siblings.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                        <select value={draft.targetFieldId} onChange={(e) => setDraft({ ...draft, targetFieldId: e.target.value })} className={SELECT} style={INPUT_STYLE} aria-label={t('datatables.nc_rel_target_column', 'Its column')} disabled={!draft.targetDatatableId}>
                            <option value="">{t('datatables.nc_rel_target_column', 'Its column')}</option>
                            {targetFields.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                        </select>
                    </div>
                    <button type="button" disabled={!complete || busy} onClick={() => save([...declared, draft])}
                        className="text-xs inline-flex items-center gap-1.5 rounded disabled:opacity-50" style={{ color: 'var(--text-secondary)' }}>
                        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <Plus className="w-3.5 h-3.5" aria-hidden="true" />}
                        {t('datatables.nc_relation_use', 'Use this relation')}
                    </button>
                </div>
            )}
            <p aria-live="polite" className="text-xs" style={{ color: error ? 'var(--warning)' : 'var(--text-secondary)' }}>
                {error || (saved ? (
                    <>
                        {t('datatables.nc_relations_saved', 'Saved. The link column is filled in on the next refresh.')}{' '}
                        <button type="button" onClick={onRefresh} className="underline" style={{ color: 'var(--text-primary)' }}>{t('datatables.nc_refresh_now', 'Refresh now')}</button>
                    </>
                ) : null)}
            </p>
        </section>
    );
}

const CARD = { borderRadius: 12, background: 'var(--bg-card)', border: '1px solid var(--border-default)', boxShadow: 'var(--shadow-sm)' };
const INPUT = 'w-full px-3 py-2 rounded-lg text-sm border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1';
const SELECT = `${INPUT} appearance-none`;
const INPUT_STYLE = { background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)', outlineColor: 'var(--accent-primary)' };
