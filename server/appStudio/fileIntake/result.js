// @typecheck
/**
 * file_intake phase 5 — the report: its full shape, and the trimmed form for
 * `resultDetail: 'summary'`.
 */

'use strict';
const { MAX_FILES_PER_INTAKE } = require('./limits');
const { PAIR_ROLES } = require('./pairing');

/** The result shape, with nothing in it — every key a caller may read. */
function emptyIntakeResult() {
    return {
        filed: 0, total: 0, parts: 0, refused: [], pairs: [],
        poFile: null, poName: null, poSource: null,
        sheetFile: null, sheetName: null, lineListFile: null, lineListName: null, sheets: [],
        sampleFile: null, sampleName: null,
        sheetOnly: [], sheetOnlySummary: '',
        skippedFolders: [], skippedSummary: '', others: [],
        emptyFolders: [], emptySummary: '',
        unpairedDrawings: [], unpairedCad: [],
        fuzzy: 0, fuzzyPairs: [], written: 0,
    };
}

function buildResult({
    files, rows, pairs, refused, poEntry, poSource, sheetEntry, sheetOnly, lineListEntry, sheetReports,
    skipped, emptyFolders, zipReports, written, truncated, quotaHit,
}) {
    // Deliberately from the PAIRS rather than from `files`: a label sheet in a
    // CAD-less folder is a file of this conversation but not a document about a
    // part, and showing a model the wrong page is worse than showing it none.
    const samplePair = pairs.find((p) => p.drawingFile) || pairs.find((p) => p.cadFile) || null;
    const sampleEntry = samplePair
        ? {
            descriptor: samplePair.drawingFile || samplePair.cadFile,
            name: samplePair.drawingName || samplePair.cadName,
        }
        : null;

    const others = files
        .filter((f) => f.kind === 'other')
        .map((f) => ({ name: f.name, file: f.descriptor }));

    const fuzzyPairs = pairs.filter((p) => p.matchStatus === 'fuzzy');
    const result = {
        filed: files.filter((f) => f.kind !== 'zip').length,
        total: rows.length,
        // How many parts this package describes. A COUNT, always present in
        // both detail modes, so a gate never has to walk the pairs array to
        // ask "did this produce anything".
        parts: pairs.length,
        refused,
        pairs,
        poFile: poEntry ? poEntry.descriptor : null,
        poName: poEntry ? poEntry.name : null,
        // How the order document was recognised: 'name' (the filename
        // pattern), 'structure' (the lone unpaired document beside real CAD
        // files) or null. An operator reading a wrong quantity deserves to
        // know which of those picked the file it came from.
        poSource,
        // ONE document to look at when the package carried no order and no
        // sheet — the first drawing, else the first CAD file.
        //
        // An app asking a model "what kind of request is this?" needs something
        // to show it, and the obvious fallback was `pairs[0].drawingFile`. That
        // reads an array which 'summary' empties and which is empty anyway when
        // nothing paired, so the honest fallback has to be a field of its own:
        // one descriptor, always present in both detail modes, null when there
        // is genuinely nothing to look at.
        sampleFile: sampleEntry ? sampleEntry.descriptor : null,
        sampleName: sampleEntry ? sampleEntry.name : null,
        // The bill of materials, when one was sent. A step reading this instead
        // of the PDF reads cells rather than a picture of cells.
        sheetFile: sheetEntry ? sheetEntry.descriptor : null,
        sheetName: sheetEntry ? sheetEntry.name : null,
        // ARTICLES THE ORDER LISTS AND THE PACKAGE DID NOT CARRY.
        //
        // The mirror image of `emptyFolders`, and the general case of it: an
        // empty folder is a missing part the ARCHIVE happened to admit to, while
        // this catches the same plate when the files were mailed loose and
        // nothing in the package hints that one is absent. The files decide
        // which lines exist, so this creates none — it only refuses to let a
        // plate go missing quietly.
        sheetOnly,
        sheetOnlySummary: sheetOnly.join(', '),
        // A file whose headers ALREADY are the target columns is not a table to
        // interpret, it is a list to import — reported apart so an app can skip
        // a model call rather than pay one to read an answer it was handed.
        lineListFile: lineListEntry ? lineListEntry.descriptor : null,
        lineListName: lineListEntry ? lineListEntry.name : null,
        // Every spreadsheet that was in the package and what it looked like, so
        // a screen can offer the other one instead of hiding that a choice
        // was made at all.
        sheets: sheetReports,
        // Folders that hold documents but no CAD file, and therefore produced no
        // project lines. Named and counted for the same reason `refused` and
        // `fuzzyPairs` are: a rule that quietly drops 77 files is
        // indistinguishable from a bug until it says which 77.
        skippedFolders: [...skipped].map(([folder, count]) => ({ folder, files: count })),
        // The same fact as one sentence. An action can count an array in a
        // formula but cannot walk one, and "which folders" is the half that
        // makes the count worth reading.
        skippedSummary: [...skipped].map(([folder, count]) => `${folder} (${count})`).join(', '),
        // Declared folders that held no file at all — the same honesty channel
        // seen from the other side: skippedFolders is 'files, but no part',
        // emptyFolders is 'a part, but no files'.
        emptyFolders,
        emptySummary: emptyFolders.join(', '),
        others,
        unpairedDrawings: pairs.filter((p) => p.role === PAIR_ROLES.DRAWING_ONLY).map((p) => p.drawingName),
        unpairedCad: pairs.filter((p) => p.role === PAIR_ROLES.CAD_ONLY).map((p) => p.cadName),
        // The honesty channel: how many pairs were NOT a 1-op-1 name match,
        // and which — the app surfaces this so a human re-checks them.
        fuzzy: fuzzyPairs.length,
        fuzzyPairs: fuzzyPairs.map((p) => ({ baseName: p.baseName, cadName: p.cadName, drawingName: p.drawingName })),
        ...(zipReports.length ? { zips: zipReports } : {}),
        written,
        ...(truncated ? { truncated: true, limit: MAX_FILES_PER_INTAKE } : {}),
        ...(quotaHit ? { code: 'quota_exceeded', remaining: Math.max(0, rows.length - files.length - refused.length) } : {}),
    };
    return result;
}

function trimForDetail(result, step, { refused, emptyFolders, sheetOnly }) {
    // ── 5. Trim, when the caller says it does not need the detail ───────
    //
    // Every result variable of a server step rides back to the browser and then
    // returns in the BODY of every later step of the same action. `pairs`
    // carries two file descriptors per part, so a 243-file order put ~110 kB in
    // that bag and the next step came back 413 — the button simply stopped
    // working, on exactly the orders this feature exists for.
    //
    // The rows are in the table either way; `pairs` is a convenience that
    // duplicates them. A caller that loops over the table instead asks for
    // 'summary' and keeps a variable bag that does not grow with the order.
    if (step.resultDetail === 'summary') {
        result.pairs = [];
        result.unpairedDrawings = [];
        result.unpairedCad = [];
        result.fuzzyPairs = [];
        result.others = [];
        // The honesty channels stay, bounded: the first few names say WHICH,
        // and the counts beside them say how many there were.
        result.refusedCount = refused.length;
        result.refused = refused.slice(0, 10);
        // These stay, bounded: they are the only place an operator learns that
        // an article folder came in empty, and a count with no names is a
        // rumour. Ten of each is enough to act on.
        result.emptyFolderCount = emptyFolders.length;
        result.emptyFolders = emptyFolders.slice(0, 10);
        result.sheetOnlyCount = sheetOnly.length;
        result.sheetOnly = sheetOnly.slice(0, 10);
        result.skippedFolders = result.skippedFolders.slice(0, 10);
        if (Array.isArray(result.zips)) {
            result.zips = result.zips.map((z) => ({
                ...z,
                refusedCount: (z.refusedEntries || []).length,
                refusedEntries: (z.refusedEntries || []).slice(0, 10),
            }));
        }
    }
}

module.exports = { emptyIntakeResult, buildResult, trimForDetail };
