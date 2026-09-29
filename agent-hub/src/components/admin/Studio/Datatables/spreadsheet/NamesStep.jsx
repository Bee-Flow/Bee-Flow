import React from 'react';
import { ColumnKindIcon } from '../ColumnKind';
import { columnTypeKind, keyFromName } from '../datatableDisplay';
import { CARD, INPUT, INPUT_STYLE } from '../linkWizardShared';

/**
 * Step 3 of the link-spreadsheet wizard: what each table is called.
 *
 * The Nextcloud wizard's names step without its column grid — the columns
 * were seen, and typed, one step ago. What is left per sheet is the name,
 * the technical name, the purpose sentence, a chip row of the columns as a
 * reminder, and how a row of it is recognised (the key column chosen in
 * step 2, or the row number).
 *
 * A name typed here is `nameTouched`, a key typed here `keyTouched`: the
 * dialog's defaults (wizardState.applyDefaults) leave both alone from then
 * on. An untouched key follows the name; two untouched keys that collide
 * are suffixed by the dialog, and only a typed collision is shown here.
 */
export default function NamesStep({ t, selection, keyDup, marks, onChange }) {
    return (
        <div className="space-y-3">
            {[...selection.values()].map((s) => {
                const dup = keyDup.includes(s.key);
                const label = s.sheet === null || s.sheet === undefined ? s.fileName : `${s.fileName} › ${s.sheet}`;
                const keyCol = Number.isInteger(s.keyColumn) ? s.columns.find(c => c.col === s.keyColumn) : null;
                return (
                    <section key={s.sheetKey} className="p-3 space-y-2" style={CARD} aria-label={label}>
                        <span className="block text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{label}</span>
                        <div className="grid gap-2" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)' }}>
                            <label className="block">
                                <span className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>{t('datatables.field_name', 'Name')}</span>
                                <input value={s.name}
                                    onChange={(e) => onChange(s.sheetKey, { name: e.target.value, nameTouched: true, ...(s.keyTouched ? {} : { key: keyFromName(e.target.value) }) })}
                                    className={INPUT} style={INPUT_STYLE} aria-label={`${t('datatables.field_name', 'Name')} — ${label}`} />
                            </label>
                            <label className="block">
                                <span className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>{t('datatables.field_key', 'Technical name')}</span>
                                <input value={s.key} onChange={(e) => onChange(s.sheetKey, { key: e.target.value, keyTouched: true })}
                                    className={`${INPUT} font-mono`} style={{ ...INPUT_STYLE, borderColor: dup ? 'var(--warning)' : INPUT_STYLE.borderColor }}
                                    aria-label={`${t('datatables.field_key', 'Technical name')} — ${label}`} />
                            </label>
                        </div>
                        {dup && <p className="text-[11px]" style={{ color: 'var(--warning)' }}>{t('datatables.nc_key_dup', 'Two tables would get the technical name “{key}”.', { key: s.key })}</p>}
                        {marks.get(s.sheetKey) && <p className="text-[11px]" style={{ color: 'var(--warning)' }}>{marks.get(s.sheetKey)}</p>}
                        <label className="block">
                            <span className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>{t('datatables.field_purpose', 'What is it for?')}</span>
                            <textarea value={s.description} onChange={(e) => onChange(s.sheetKey, { description: e.target.value })} rows={1}
                                className={INPUT} style={INPUT_STYLE} aria-label={`${t('datatables.field_purpose', 'What is it for?')} — ${label}`} />
                            <span className="block text-[11px] mt-1" style={{ color: 'var(--text-tertiary)' }}>
                                {t('datatables.field_purpose_managed', 'Optional here — left empty, this kind of table brings its own sentence for the processing record.')}
                            </span>
                        </label>
                        <div className="flex flex-wrap items-center gap-1.5">
                            {s.columns.map((c) => (
                                <span key={c.col} className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}>
                                    <ColumnKindIcon kind={columnTypeKind(c.type)} size={11} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
                                    {c.blankHeader ? c.key : c.header}
                                </span>
                            ))}
                            <span className="text-[11px] ml-auto" style={{ color: 'var(--text-tertiary)' }}>
                                {keyCol
                                    ? t('datatables.ss_names_identity_key', 'recognised by {column}', { column: keyCol.blankHeader ? keyCol.key : keyCol.header })
                                    : t('datatables.ss_names_identity_rownum', 'recognised by row number')}
                            </span>
                        </div>
                    </section>
                );
            })}
        </div>
    );
}
