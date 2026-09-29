import { ArrowLeft, FileSpreadsheet, Loader2 } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { KEY_RE, providerLogoId, ssErrorMessage } from './datatableDisplay';
import { datatablesApi } from './datatablesApi';
import { AudienceLine, BTN, CARD, RelationsStep, ReviewRelations, StepStrip, messageFor, relKeyOf, suggestRelations } from './linkWizardShared';
import { TitleRow } from './NewDatatableDialog';
import FileBrowser from './spreadsheet/FileBrowser';
import NamesStep from './spreadsheet/NamesStep';
import SheetsStep from './spreadsheet/SheetsStep';
import {
    MAX_TABLES_PER_LINK, STEPS, applyDefaults, buildLinkBody, describeKeyOf, fileKeyOf, keyColumnEligible, mergeColumns, newSelection,
    sheetKeyOf, stepForError,
} from './spreadsheet/wizardState';
import useTranslation from '../../../../hooks/useTranslation';
import { getIntegrationLogo } from '../../../../utils/integrationLogos';
import Modal from '../../../shared/Modal';
import { PRIMARY_ACTION_STYLE } from '../../../shared/StudioSectionHeader';

/**
 * Link one or several worksheets of spreadsheet files — in Google Drive,
 * OneDrive or Nextcloud Files — as datatables. Five steps in one dialog:
 *
 *   1. Files              a browser per connected storage; tick the files
 *   2. Sheets & columns   per file: the sheets to link; per sheet: header
 *                         row, preview, column types, how a row is recognised
 *   3. Names              name, technical name, purpose per sheet
 *   4. Relations          "A.x matches B.y", suggested by same title
 *   5. Review             the audience, the list, then Link
 *
 * The Nextcloud Tables twin (LinkNextcloudTablesDialog) picks from a flat
 * list the server already read; here the server has read NOTHING until a
 * file is ticked, so the reading happens between steps 1 and 2 (the file:
 * its sheets, how it can be written back) and again per sheet and per
 * header row (the columns as they would arrive). Every describe is cached
 * by its key, so stepping back and forth reads nothing twice.
 *
 * The state is three maps and a list (see spreadsheet/wizardState.js for
 * the keys); the rules — default names, key suffixes, which column may be
 * the key, the exact body, where a refusal goes — are that module's, so
 * this file is about sequencing and fetching.
 *
 * Relations name a column by its 0-based `col` in its sheet: the datatable
 * fields do not exist yet, and a letter is for reading, not sending.
 */
export default function LinkSpreadsheetDialog({ scope, providers, onBack, onClose, onLinked }) {
    const { t } = useTranslation();
    const [step, setStep] = useState('files');
    const [files, setFiles] = useState(() => new Map());            // fileKey → browse item (+provider, +sharedWriteOptIn)
    const [describes, setDescribes] = useState(() => new Map());    // fileKey → {loading, error, data}
    const [sheetDescribes, setSheetDescribes] = useState(() => new Map());   // describeKey → {loading, error, data}
    const [selection, setSelection] = useState(() => new Map());    // sheetKey → the table-to-be
    const [relations, setRelations] = useState([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [marks, setMarks] = useState(() => new Map());            // fileKey | sheetKey → sentence

    const selected = useMemo(() => [...selection.values()], [selection]);

    // ── step 1: files ──────────────────────────────────────────────
    const toggleFile = (item) => {
        const fk = fileKeyOf(item.provider, item.id);
        setFiles((prev) => {
            const next = new Map(prev);
            if (next.has(fk)) next.delete(fk); else next.set(fk, { ...item, sharedWriteOptIn: false });
            return next;
        });
        if (files.has(fk)) {
            setSelection(prev => applyDefaults(new Map([...prev].filter(([, s]) => s.fileKey !== fk))));
        }
    };

    // ── step 2: sheets ─────────────────────────────────────────────
    const toggleSheet = (file, sheet) => {
        const sk = sheetKeyOf(fileKeyOf(file.provider, file.id), sheet);
        setSelection((prev) => {
            const next = new Map(prev);
            if (next.has(sk)) next.delete(sk);
            else next.set(sk, { ...newSelection(file, sheet), sharedWriteOptIn: !!file.sharedWriteOptIn });
            return applyDefaults(next);
        });
    };
    const setSel = (sheetKey, patch) => setSelection((prev) => {
        if (!prev.has(sheetKey)) return prev;
        const next = new Map(prev);
        next.set(sheetKey, { ...prev.get(sheetKey), ...patch });
        return applyDefaults(next);
    });
    // The opt-in is per FILE (it is the file that belongs to someone else)
    // and travels onto every sheet of it, because the body is per table.
    const setOptIn = (fileKey, on) => {
        setFiles(prev => (prev.has(fileKey) ? new Map(prev).set(fileKey, { ...prev.get(fileKey), sharedWriteOptIn: on }) : prev));
        setSelection((prev) => {
            const next = new Map(prev);
            for (const [k, s] of prev) if (s.fileKey === fileKey) next.set(k, { ...s, sharedWriteOptIn: on });
            return next;
        });
    };
    const retryFile = (fileKey) => setDescribes((prev) => { const next = new Map(prev); next.delete(fileKey); return next; });

    // Read each ticked file once, on entering the step: its sheets, how it
    // can be written back, and its first sheet at header row 1 — which is
    // seeded into the sheet cache so the common case costs one call. A file
    // with one sheet is selected on the spot: there is nothing to tick.
    // A csv's only sheet is named `null` on the wire; that null is its
    // identity here too (the keys, the second read, the body), so the seed
    // lands under the same key the selection will ask for.
    useEffect(() => {
        if (step !== 'sheets') return;
        for (const f of files.values()) {
            const fk = fileKeyOf(f.provider, f.id);
            if (describes.has(fk)) continue;
            setDescribes(d => new Map(d).set(fk, { loading: true, error: null, data: null }));
            datatablesApi.describeSpreadsheet({ provider: f.provider, fileId: f.id, scope })
                .then((b) => {
                    const first = b && b.sheet;
                    if (first) {
                        setSheetDescribes(m => new Map(m).set(describeKeyOf(fk, first.name ?? null, first.headerRow || 1), { loading: false, error: null, data: b }));
                    }
                    setDescribes(d => new Map(d).set(fk, { loading: false, error: null, data: b }));
                    const sheets = (b && b.sheets) || [];
                    if (sheets.length === 1 && !(Array.isArray(sheets[0].linkedAs) && sheets[0].linkedAs.length)) {
                        const only = sheets[0].name ?? null;
                        const sk = sheetKeyOf(fk, only);
                        setSelection(prev => (prev.has(sk) ? prev
                            : applyDefaults(new Map(prev).set(sk, { ...newSelection(f, only), sharedWriteOptIn: !!f.sharedWriteOptIn }))));
                    }
                })
                .catch(e => setDescribes(d => new Map(d).set(fk, { loading: false, error: e, data: null })));
        }
    }, [step, files, describes, scope]);

    // Every selected sheet needs its describe at ITS header row: read it
    // when missing, and when it has arrived, hand the columns to the
    // selection (keeping the person's type choices where the column is
    // still the same) — once, which `describeKey` on the entry records.
    useEffect(() => {
        for (const s of selected) {
            const key = describeKeyOf(s.fileKey, s.sheet, s.headerRow);
            const d = sheetDescribes.get(key);
            if (!d) {
                setSheetDescribes(m => new Map(m).set(key, { loading: true, error: null, data: null }));
                datatablesApi.describeSpreadsheet({ provider: s.provider, fileId: s.fileId, sheet: s.sheet, headerRow: s.headerRow, scope })
                    .then(b => setSheetDescribes(m => new Map(m).set(key, { loading: false, error: null, data: b })))
                    .catch(e => setSheetDescribes(m => new Map(m).set(key, { loading: false, error: e, data: null })));
            } else if (!d.loading && !d.error && d.data && s.describeKey !== key) {
                setSelection((prev) => {
                    const cur = prev.get(s.sheetKey);
                    if (!cur || cur.describeKey === key || describeKeyOf(cur.fileKey, cur.sheet, cur.headerRow) !== key) return prev;
                    const columns = mergeColumns(cur.columns, (d.data.sheet && d.data.sheet.columns) || []);
                    const keyCol = columns.find(c => c.col === cur.keyColumn);
                    const keyColumn = keyCol && keyColumnEligible(keyCol, d.data.keyCandidates || []).ok ? cur.keyColumn : null;
                    return new Map(prev).set(s.sheetKey, { ...cur, columns, keyColumn, describeKey: key });
                });
            }
        }
    }, [selected, sheetDescribes, scope]);

    const described = (s) => s.describeKey === describeKeyOf(s.fileKey, s.sheet, s.headerRow) && s.columns.length > 0;
    const sheetsOk = selected.length > 0 && selected.length <= MAX_TABLES_PER_LINK && selected.every(described);

    // ── step 3: names ──────────────────────────────────────────────
    const keyDup = useMemo(() => {
        const seen = new Map();
        for (const s of selected) seen.set(s.key, (seen.get(s.key) || 0) + 1);
        return [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);
    }, [selected]);
    const namesOk = selected.every(s => s.name.trim() && KEY_RE.test(s.key)) && keyDup.length === 0;

    // ── step 4: relations ──────────────────────────────────────────
    const relTables = useMemo(() => selected.map(s => ({
        refKey: s.sheetKey, name: s.name, key: s.key, provider: s.provider, fileId: s.fileId, sheet: s.sheet,
        columns: s.columns.filter(c => !c.formula).map(c => ({ id: String(c.col), title: c.blankHeader ? c.key : c.header, type: c.type, col: c.col })),
    })), [selected]);
    const suggestions = useMemo(() => suggestRelations(relTables), [relTables]);
    // A relation outlives neither of its ends: unticking a sheet, or moving
    // a header row so a column is gone, drops it rather than sending the
    // server a relation to a table that is not being made.
    const liveRelations = useMemo(() => relations.filter((r) => {
        const from = selection.get(r.from.refKey), to = selection.get(r.to.refKey);
        return !!from && !!to && from.columns.some(c => c.col === r.localColumn.col) && to.columns.some(c => c.col === r.targetColumn.col);
    }), [relations, selection]);
    const hasRel = (r) => liveRelations.some(x => relKeyOf(x) === relKeyOf(r));
    const addRelation = (r) => { if (!hasRel(r)) setRelations(list => [...list, r]); };
    const removeRelation = (r) => setRelations(list => list.filter(x => relKeyOf(x) !== relKeyOf(r)));

    // ── submit ─────────────────────────────────────────────────────
    const submit = async () => {
        setBusy(true);
        setError(null);
        setMarks(new Map());
        try {
            const body = await datatablesApi.linkSpreadsheets(buildLinkBody({ scope, selection, relations: liveRelations }));
            onLinked(body);
        } catch (e) {
            const msg = ssErrorMessage(t, e) || messageFor(t, e);
            // Point at the row it is about, and go back to the step that can fix it.
            const route = stepForError(e);
            const m = new Map();
            const byKey = route.key ? selected.find(s => s.key === route.key) : null;
            if (byKey) m.set(byKey.sheetKey, msg);
            else if (route.sheetKey && selection.has(route.sheetKey)) m.set(route.sheetKey, msg);
            else if (route.fileKey && files.has(route.fileKey)) m.set(route.fileKey, msg);
            setMarks(m);
            if (route.step) setStep(route.step);
            setError(msg);
        } finally {
            setBusy(false);
        }
    };

    const at = STEPS.indexOf(step);
    const canNext = step === 'files' ? files.size > 0 : step === 'sheets' ? sheetsOk : step === 'names' ? namesOk : true;
    const next = () => setStep(STEPS[Math.min(STEPS.length - 1, at + 1)]);
    const back = () => (at === 0 ? onBack() : setStep(STEPS[at - 1]));
    const labels = [
        t('datatables.ss_step_files', 'Files'),
        t('datatables.ss_step_sheets', 'Sheets & columns'),
        t('datatables.nc_step_names', 'Names & columns'),
        t('datatables.nc_step_relations', 'Relations'),
        t('datatables.nc_step_review', 'Review'),
    ];

    return (
        <Modal
            open
            onClose={busy ? () => {} : onClose}
            size="lg"
            title={<TitleRow kind="datatable" icon={FileSpreadsheet} text={t('datatables.ss_link_title', 'Link spreadsheets from your files')} />}
            headerActions={<StepStrip t={t} at={at} labels={labels} />}
            footer={(
                <>
                    <button type="button" onClick={back} disabled={busy} className={`${BTN} border inline-flex items-center gap-1.5`}
                        style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)', outlineColor: 'var(--accent-primary)' }}>
                        <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
                        {t('datatables.nc_back', 'Back')}
                    </button>
                    <span className="mr-auto text-[11px] pl-2" style={{ color: 'var(--text-tertiary)' }}>
                        {step === 'sheets' && selected.length > MAX_TABLES_PER_LINK
                            ? t('datatables.ss_max_tables', 'At most {n} sheets can be linked in one go.', { n: MAX_TABLES_PER_LINK })
                            : null}
                    </span>
                    <button type="button" onClick={onClose} disabled={busy} className={`${BTN} border`}
                        style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)', outlineColor: 'var(--accent-primary)' }}>
                        {t('datatables.cancel', 'Cancel')}
                    </button>
                    {step !== 'review' ? (
                        <button type="button" onClick={next} disabled={!canNext} className={`${BTN} font-medium disabled:opacity-50`}
                            style={{ ...PRIMARY_ACTION_STYLE, outlineColor: 'var(--accent-primary)' }}>
                            {t('datatables.nc_next', 'Next')}
                        </button>
                    ) : (
                        <button type="button" onClick={submit} disabled={busy || !selected.length} className={`${BTN} font-medium disabled:opacity-50 inline-flex items-center gap-1.5`}
                            style={{ ...PRIMARY_ACTION_STYLE, outlineColor: 'var(--accent-primary)' }}>
                            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />}
                            {selected.length === 1
                                ? t('datatables.ss_link_submit_one', 'Link the sheet')
                                : t('datatables.ss_link_submit', 'Link {n} sheets', { n: selected.length })}
                        </button>
                    )}
                </>
            )}
        >
            <div className="space-y-4">
                {step === 'files' && (
                    <FileBrowser t={t} scope={scope} providers={providers || []} files={files} onToggle={toggleFile} marks={marks} />
                )}
                {step === 'sheets' && (
                    <SheetsStep t={t} files={files} describes={describes} sheetDescribes={sheetDescribes} selection={selection} marks={marks}
                        onToggleSheet={toggleSheet} onChange={setSel} onOptIn={setOptIn} onRetry={retryFile} />
                )}
                {step === 'names' && (
                    <NamesStep t={t} selection={selection} keyDup={keyDup} marks={marks} onChange={setSel} />
                )}
                {step === 'relations' && (
                    <RelationsStep t={t} tables={relTables} suggestions={suggestions} relations={liveRelations}
                        hasRel={hasRel} onAdd={addRelation} onRemove={removeRelation}
                        intro={t('datatables.ss_relations_intro', 'A relation gives every row of one sheet a link to one row of another: match a column of each.')}
                        needTwo={t('datatables.ss_relations_need_two', 'Select at least two sheets to relate them.')} />
                )}
                {step === 'review' && (
                    <ReviewStep t={t} scope={scope} selected={selected} files={files} describes={describes} relations={liveRelations} onChangeScope={onBack} />
                )}
                {error && (
                    <p role="alert" className="text-xs px-3 py-2 rounded-lg" style={{ background: 'var(--bg-primary)', color: 'var(--warning)' }}>{error}</p>
                )}
            </div>
        </Modal>
    );
}

/** A file the server will read but not write — unless the linker opted in to writing a shared one. */
function readOnly(file, describe) {
    const write = describe && describe.data && describe.data.write;
    if (!write || write.mode !== 'none') return false;
    return !(write.reason === 'not_owned' && file && file.sharedWriteOptIn);
}

function ReviewStep({ t, scope, selected, files, describes, relations, onChangeScope }) {
    const anyReadOnly = selected.some(s => readOnly(files.get(s.fileKey), describes.get(s.fileKey)));
    return (
        <div className="space-y-3 text-sm" style={{ color: 'var(--text-primary)' }}>
            <AudienceLine t={t} scope={scope} onChange={onChangeScope} />
            <ul className="space-y-1">
                {selected.map((s) => {
                    const Logo = getIntegrationLogo(providerLogoId(s.provider, s.format));
                    const keyCol = Number.isInteger(s.keyColumn) ? s.columns.find(c => c.col === s.keyColumn) : null;
                    return (
                        <li key={s.sheetKey} className="flex items-center gap-2 p-2.5 flex-wrap" style={CARD}>
                            {Logo
                                ? <span className="shrink-0 inline-flex" aria-hidden="true">{React.createElement(Logo, { size: 14 })}</span>
                                : <FileSpreadsheet className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--type-data)' }} aria-hidden="true" />}
                            <span className="truncate font-medium">{s.name}</span>
                            <span className="text-[11px] truncate" style={{ color: 'var(--text-tertiary)' }}>
                                {/* A csv's only sheet has no name: the file alone, not "file › null". */}
                                {s.sheet === null || s.sheet === undefined
                                    ? s.fileName
                                    : t('datatables.ss_review_sheet', '{file} › {sheet}', { file: s.fileName, sheet: s.sheet })}
                                {' · '}
                                {keyCol
                                    ? t('datatables.ss_review_identity_key', 'key: {column}', { column: keyCol.blankHeader ? keyCol.key : keyCol.header })
                                    : t('datatables.ss_review_identity_rownum', 'row number')}
                            </span>
                            <code className="ml-auto text-[11px] font-mono shrink-0" style={{ color: 'var(--text-tertiary)' }}>{s.key}</code>
                        </li>
                    );
                })}
            </ul>
            <ReviewRelations t={t} relations={relations} />
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                {t('datatables.ss_review_note', 'The rows are copied from the files in the background and kept in step with them. Rows you change here are written to the file.')}
            </p>
            {anyReadOnly && (
                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    {t('datatables.ss_review_readonly_note', 'One or more files are read-only here; their rows cannot be changed from Bee Flow.')}
                </p>
            )}
        </div>
    );
}
