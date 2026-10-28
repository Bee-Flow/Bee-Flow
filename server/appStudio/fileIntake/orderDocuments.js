// @typecheck
/**
 * file_intake phases 3b/3c — the order document when its name does not say
 * so, and the bill of materials when one was sent.
 */

'use strict';
const { normalizeBase, sharesNumberFamily } = require('./naming');
const { sizeOfDescriptor } = require('./attachmentRows');
const { PAIR_ROLES } = require('./pairing');
const log = require('../../telemetry/log');

// How many spreadsheets we OPEN to find out what they are. A package carries
// one bill of materials and a couple of strays; past this the biggest ones
// were opened and the rest still rank by size, exactly as they always did.
const MAX_SHEETS_SCANNED = 10;

/** Returns `{ poEntry, poSource }`; a structural pick is removed from `pairs`. */
function findOrderDocument(po, pairs) {
    // ── 3b. The order document, when its NAME does not say so ───────────
    // Tier 1 is the filename pattern above, and it only ever knew one
    // customer's naming ("Inkoopbestelbon_PO24118.pdf"). A supplier whose
    // order is called "B263232.pdf" fell straight through to 'drawing', which
    // cost twice over: the purchase order became a project line of its own,
    // and the step that reads the quantities off it was handed nothing.
    //
    // Tier 2 is structural rather than lexical, and stays inside the same rule
    // as the pairing: never guess between candidates. One unpaired PDF sitting
    // beside files that DID pair with CAD is the paperwork — two unpaired PDFs
    // is a customer who forgot a CAD file, and picking one of those is how you
    // cut the wrong plate.
    let poEntry = po;
    let poSource = po ? 'name' : null;
    if (!poEntry) {
        const orphans = pairs.filter((/** @type {{ role: string; }} */ p) => p.role === PAIR_ROLES.DRAWING_ONLY);
        const family = pairs.filter((p) => p.cadFile).map((p) => p.baseName);
        const orphan = orphans.length === 1 ? orphans[0] : null;
        // The second half of the rule, and the one that stops it cutting a
        // part: an unpaired drawing whose number sits in the SAME family as
        // the CAD files is a plate whose model went missing, never the order.
        // "MW2604-01-3021-001.step" beside "MW2604-01-3022-001.pdf" shares
        // thirteen characters — that is a sibling. "B263232.pdf" beside
        // "19.0592.136.01_alu_5mm.DXF" shares none — that is paperwork.
        if (orphan && family.length && !family.some((key) => sharesNumberFamily(orphan.baseName, key))) {
            pairs.splice(pairs.indexOf(orphan), 1);
            poEntry = { name: orphan.drawingName, descriptor: orphan.drawingFile };
            poSource = 'structure';
        }
    }
    return { poEntry, poSource };
}

/**
 * Returns `{ sheetReports, sheetOnly, sheetEntry, lineListEntry }`. The
 * mailboxAttachments module is lent by the orchestrator, so this module stays
 * out of the import cycle that one sits in.
 */
async function scanSheets(app, files, pairs, { mailbox }) {
    // ── 3c. The bill of materials, if one was sent ──────────────────────
    // Reported SEPARATELY from the order document rather than instead of it,
    // because a real order sends both and they are not the same thing: the PDF
    // is the letter (who, when, which reference) and the sheet is the table
    // (position, quantity, material, thickness, per line). One is read by a
    // model looking at a page; the other is read exactly, from cells.
    //
    // The largest sheet wins when several arrive — a bill of materials is the
    // big one, and a stray "contactgegevens.csv" is not. Never a guess between
    // equals: on a tie the first by name keeps the deterministic order the
    // whole step is built on.
    const sheets = files.filter((f) => f.kind === 'sheet' && f.descriptor);
    const sheetReports = [];
    const sheetOnly = [];
    let sheetEntry = null;
    let lineListEntry = null;
    if (sheets.length) {
        const { scanSheet } = require('../sheetScan');
        const partKeys = [...new Set(pairs.map((pair) => pair.partKey).filter(Boolean))];
        const opened = [...sheets].sort((a, b) => sizeOfDescriptor(b) - sizeOfDescriptor(a))
            .slice(0, MAX_SHEETS_SCANNED);
        for (const f of opened) {
            try {
                const bytes = typeof mailbox.getStoredAttachmentBuffer === 'function'
                    ? await mailbox.getStoredAttachmentBuffer(app, f.descriptor.fileId)
                    : null;
                if (bytes && bytes.length) f.scan = scanSheet(bytes, { partKeys, normalize: normalizeBase });
            } catch (err) { log.debug('a sheet we cannot open ranks by size, exactly as before', err); }
        }
        for (const f of sheets) {
            sheetReports.push({
                name: f.name,
                rows: f.scan ? f.scan.rows : null,
                columns: f.scan ? f.scan.columns : null,
                hits: f.scan ? f.scan.hits : null,
                missing: f.scan ? f.scan.unmatchedCount : null,
                lineList: Boolean(f.scan && f.scan.lineList),
            });
        }
        // Naming the parts beats being big; among sheets that name the same
        // parts the WIDER table wins, because that is the one that still has a
        // thickness column. With nothing read at all every rank collapses to
        // the plain size rule.
        const rank = (f) => [f.scan ? f.scan.hits : 0, f.scan ? f.scan.columns : 0, sizeOfDescriptor(f)];
        const better = (a, b) => {
            const ra = rank(a);
            const rb = rank(b);
            for (let i = 0; i < ra.length; i += 1) if (ra[i] !== rb[i]) return ra[i] > rb[i] ? a : b;
            return a;                       // a tie keeps the order we found them in
        };
        const best = (list) => (list.length ? list.reduce(better) : null);
        const asTable = sheets.filter((f) => !(f.scan && f.scan.lineList));
        sheetEntry = best(asTable.length ? asTable : sheets);
        lineListEntry = best(sheets.filter((f) => f.scan && f.scan.lineList));
        // Only the sheet we actually believe. A stray export that named no part
        // we recognise has no standing to declare anything missing.
        if (sheetEntry && sheetEntry.scan && sheetEntry.scan.hits) {
            sheetOnly.push(...sheetEntry.scan.unmatched);
        }
    }
    return { sheetReports, sheetOnly, sheetEntry, lineListEntry };
}

module.exports = { MAX_SHEETS_SCANNED, findOrderDocument, scanSheets };
