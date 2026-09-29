/**
 * The link-spreadsheet wizard's state, as pure functions — what the
 * selection maps are keyed by, what a table is called by default, which
 * column may be the key, what the server is sent, and which step a refusal
 * sends the person back to.
 *
 * Pure and React-free so the rules a link is judged by are testable without
 * mounting five steps, and so the components are only about rendering them.
 *
 * ── THREE MAPS, THREE KEYS ──────────────────────────────────────────
 *   files       fileKey  = `${provider}:${fileId}`         a file ticked in the browser
 *   describes   fileKey                                   the file's describe (sheets, write mode, first sheet)
 *   describes   describeKey = `${fileKey}#${sheet}@${headerRow}`  one sheet at one header row
 *   selection   sheetKey = `${fileKey}#${sheet}`           a sheet that becomes a table
 * The provider is part of every key because two storages can hand out the
 * same id — Nextcloud's id is a path, and "/Documents/facturen.xlsx" is a
 * perfectly good OneDrive name too.
 *
 * ── COLUMNS ARE ADDRESSED BY A 0-BASED `col` ───────────────────────
 * Everywhere on the wire (identity, columns, relations). The letter the
 * server sends beside it is for reading, never for sending.
 *
 * ── A CSV'S SHEET IS `null` ─────────────────────────────────────────
 * A csv has exactly one sheet and it has no name: the server lists it as
 * `{ name: null }` and takes `sheet: null` back in the link body (its
 * reader contract — formats/index.js). The `null` is the sheet's IDENTITY
 * and travels as such: into the keys (`…#null`), the describe call and the
 * body. It is never a word to print — `sheetLabelOf` gives every screen
 * the file's name in its place, and the selection entry carries that as
 * `sheetLabel` so a step need not know the rule.
 */

import { COLUMN_TYPES, keyFromName, providerName } from '../datatableDisplay';

export const fileKeyOf = (provider, fileId) => `${provider}:${fileId}`;
export const sheetKeyOf = (fileKey, sheet) => `${fileKey}#${sheet}`;
export const describeKeyOf = (fileKey, sheet, headerRow) => `${fileKey}#${sheet}@${headerRow}`;

/** What a sheet is called on screen: its name, or — for the unnamed only sheet of a csv — the file's. */
export const sheetLabelOf = (sheet, fileName) => (sheet === null || sheet === undefined || sheet === '' ? String(fileName || '') : String(sheet));

export const STEPS = Object.freeze(['files', 'sheets', 'names', 'relations', 'review']);
export const MAX_TABLES_PER_LINK = 10;
export const HEADER_ROW_MIN = 1;
export const HEADER_ROW_MAX = 50;

/**
 * The types a sheet column can be declared as. The server infers the first
 * five from the cells; `select` is a person's opt-in (its options are the
 * distinct values at link time). The rest of COLUMN_TYPES need something a
 * header row cannot say — options of a multiselect, a file reference — so
 * they are not offered here.
 */
const INFERABLE = new Set(['text', 'number', 'date', 'datetime', 'bool', 'select']);
export const INFERABLE_TYPES = Object.freeze(COLUMN_TYPES.filter(ct => INFERABLE.has(ct.type)));

/** Types a key column may have: an identifier is a code or a number, not a date. */
const KEY_TYPES = new Set(['text', 'number']);

/** "facturen.xlsx" → "facturen"; a Google Sheet's name has no extension and stays whole. */
export function baseName(fileName) {
    const name = String(fileName || '').trim();
    const m = name.match(/^(.+)\.([a-z0-9]{1,5})$/i);
    return m ? m[1] : name;
}

/**
 * What a table is called before the person says otherwise: the file's name
 * when it contributes one sheet, "<file> – <sheet>" when several sheets of
 * the same file are linked — two tables both called "Facturen 2026" would
 * be told apart only by their technical names.
 */
export function defaultName(file, sheet, sheetsChosenInFile) {
    const base = baseName(file?.name);
    return sheetsChosenInFile > 1 ? `${base} – ${sheet}` : base;
}

export function defaultKey(name) {
    return keyFromName(name);
}

/** How many sheets of one file are selected. */
export function sheetsChosenIn(selection, fileKey) {
    let n = 0;
    for (const s of selection.values()) if (s.fileKey === fileKey) n += 1;
    return n;
}

/** How many files in one storage are selected — the tab badge. */
export function filesSelectedIn(files, provider) {
    let n = 0;
    for (const f of files.values()) if (f.provider === provider) n += 1;
    return n;
}

/**
 * Give every technical name a person has not touched a suffix where it
 * collides — `_2`, `_3` — in selection order. A name the person typed is
 * left alone (NamesStep shows the collision instead); an auto-suffixed
 * key is still `keyTouched:false`, so it re-derives when the name changes.
 */
export function dedupeKeys(selection) {
    const next = new Map();
    const taken = new Set();
    for (const s of selection.values()) if (s.keyTouched) taken.add(s.key);
    for (const [k, s] of selection) {
        if (s.keyTouched) { next.set(k, s); continue; }
        const base = defaultKey(s.name) || 'sheet';
        let key = base;
        for (let i = 2; taken.has(key); i += 1) key = `${base}_${i}`;
        taken.add(key);
        next.set(k, key === s.key ? s : { ...s, key });
    }
    return next;
}

/**
 * Re-derive the defaults after the selection changed: untouched names
 * follow the "one sheet or several" rule, untouched keys follow the name,
 * then the keys are made unique. Returns a NEW map only when something
 * moved, so a state setter can hand back the same object.
 */
export function applyDefaults(selection) {
    let changed = false;
    const named = new Map();
    for (const [k, s] of selection) {
        if (s.nameTouched) { named.set(k, s); continue; }
        const name = defaultName({ name: s.fileName }, s.sheet, sheetsChosenIn(selection, s.fileKey));
        if (name === s.name) { named.set(k, s); continue; }
        changed = true;
        named.set(k, { ...s, name });
    }
    const deduped = dedupeKeys(named);
    for (const [k, s] of deduped) if (s !== selection.get(k)) changed = true;
    return changed ? deduped : selection;
}

/**
 * May this column be the key? Only a column the server found unique over
 * the FULL read (`keyCandidates`) and that is still text or number after
 * the person's retype, with a header to call it by. The reason is the word
 * the radio shows when it is off.
 */
export function keyColumnEligible(col, keyCandidates = []) {
    if (!col) return { ok: false, reason: 'type' };
    if (col.blankHeader) return { ok: false, reason: 'no_header' };
    if (!KEY_TYPES.has(col.type)) return { ok: false, reason: 'type' };
    if (!keyCandidates.includes(col.col)) return { ok: false, reason: 'repeats' };
    return { ok: true, reason: null };
}

/**
 * After a re-describe (the header row moved), keep the person's type
 * choices where the same column is still there — same position AND same
 * header — and take the server's inference for everything else.
 */
export function mergeColumns(prev, next) {
    return (next || []).map((c) => {
        const p = (prev || []).find(x => x.col === c.col && x.header === c.header);
        return p && p.typeTouched ? { ...c, type: p.type, typeTouched: true } : c;
    });
}

/**
 * A new selection entry for one sheet of one file. Columns arrive with the
 * sheet's describe; until then the entry is "chosen, not read yet", which
 * is what keeps Next off. `sheet` is the wire identity (null for a csv);
 * `sheetLabel` is the word for it on screen.
 */
export function newSelection(file, sheet) {
    const fileKey = fileKeyOf(file.provider, file.id);
    return {
        sheetKey: sheetKeyOf(fileKey, sheet),
        fileKey,
        provider: file.provider,
        fileId: file.id,
        fileName: file.name,
        format: file.format || null,
        path: file.path || null,
        sheet,
        sheetLabel: sheetLabelOf(sheet, file.name),
        headerRow: 1,
        columns: [],
        keyColumn: null,
        name: '',
        key: '',
        nameTouched: false,
        keyTouched: false,
        description: '',
        sharedWriteOptIn: false,
    };
}

/** The body of POST /spreadsheets/link — EXACTLY the contract, nothing the server did not ask for. */
export function buildLinkBody({ scope, selection, relations }) {
    return {
        scope,
        tables: [...selection.values()].map(s => ({
            provider: s.provider,
            fileId: s.fileId,
            ...(s.path ? { path: s.path } : {}),
            sheet: s.sheet ?? null,                 // a csv's only sheet: null, as the server names it
            headerRow: s.headerRow,
            keyColumn: Number.isInteger(s.keyColumn) ? s.keyColumn : null,
            columns: s.columns.map(c => ({ col: c.col, header: c.header, type: c.type })),
            ...(s.sharedWriteOptIn ? { sharedWriteOptIn: true } : {}),
            name: s.name.trim(),
            key: s.key,
            ...(s.description.trim() ? { description: s.description.trim() } : {}),
        })),
        relations: (relations || []).map(r => ({
            from: { provider: r.from.provider, fileId: r.from.fileId, sheet: r.from.sheet ?? null, col: r.localColumn.col },
            to: { provider: r.to.provider, fileId: r.to.fileId, sheet: r.to.sheet ?? null, col: r.targetColumn.col },
        })),
    };
}

const SHEET_ERRORS = new Set(['already_linked', 'key_not_unique', 'header_missing', 'key_missing', 'sheet_missing']);
const FILE_ERRORS = new Set([
    'provider_not_connected', 'provider_integration_off', 'nc_scope_denied', 'spreadsheet_forbidden',
    'spreadsheet_not_found', 'format_unsupported', 'spreadsheet_too_large', 'spreadsheet_unavailable', 'linker_unavailable',
]);

/**
 * Which step can fix a refusal, and what to mark there. A `key_taken` is
 * about a technical name (names step); a sheet the server would not read is
 * marked by its `ref` on the sheets step; a storage that refused is marked
 * on the file, back on the files step. Anything else stays where it was.
 */
export function stepForError(err) {
    const body = err?.body || {};
    const ref = body.ref || {};
    const fileKey = ref.provider && ref.fileId ? fileKeyOf(ref.provider, ref.fileId) : null;
    switch (true) {
        case err?.code === 'key_taken':
            return { step: 'names', key: body.key || null, fileKey: null, sheetKey: null };
        case SHEET_ERRORS.has(err?.code):
            return { step: 'sheets', key: null, fileKey, sheetKey: fileKey && ref.sheet ? sheetKeyOf(fileKey, ref.sheet) : null };
        case FILE_ERRORS.has(err?.code):
            return { step: 'files', key: null, fileKey, sheetKey: null };
        case err?.code === 'relation_cross_scope':
            return { step: 'relations', key: null, fileKey: null, sheetKey: null };
        default:
            return { step: null, key: null, fileKey: null, sheetKey: null };
    }
}

/** Why a storage cannot be used right now — the probe's reason, as a sentence. */
export function ssReasonText(t, { provider, reason } = {}) {
    const source = providerName(provider);
    switch (reason) {
        case 'not_connected':
            return t('datatables.ss_reason_not_connected', '{source} is not connected for this account. Connect it under Settings → Connections.', { source });
        case 'needs_reauth':
            return t('datatables.ss_reason_needs_reauth', 'The {source} connection has expired. Renew it under Settings → Connections.', { source });
        case 'integration_off':
            return t('datatables.ss_reason_integration_off', '{source} is switched off for this organisation. An administrator can switch it on under Organisation → Integrations.', { source });
        case 'nc_scope_denied':
            return t('datatables.ss_reason_nc_scope_off', 'Bee Flow may not read this account’s Nextcloud files yet. Choose folders under Settings → Connections → Nextcloud.');
        case 'not_nc_org':
            return t('datatables.err_not_nc_org', 'This organisation is not connected to Nextcloud.');
        default:
            return t('datatables.ss_reason_unavailable', '{source} cannot be used just now.', { source });
    }
}

/** The code family a refusal belongs to, for the "Connect it under Settings" hint. */
export function isProviderError(err) {
    return /^provider_/.test(String(err?.code || ''));
}
