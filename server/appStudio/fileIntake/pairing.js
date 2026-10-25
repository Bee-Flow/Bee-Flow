// @typecheck
/**
 * file_intake phase 3 — pair drawings with their CAD files. Exact first, then
 * SAFE normalisations only; deterministic, no I/O.
 */

'use strict';
const {
    baseNameOf, canonicalBaseOf, operationOf, partKeyOf, partNameForFolder, containsPrefix, cadPreferenceWith,
} = require('./naming');

// Which CountCustom-style outputs writeTo.mapping may name. Mirrors
// FILE_INTAKE_OUTPUTS in validate.js — the executor is lenient (unknown
// output → null) because validation already refused it at save time.
const PAIR_ROLES = { BOTH: 'paired', CAD_ONLY: 'cad_only', DRAWING_ONLY: 'drawing_only' };

/** Returns `{ po, pairs, skipped }`: the PO found by name, the pairs, and the CAD-less folders. */
function pairFiles(files, step) {
    // ── 3. Pair — exact first, then SAFE normalisations only ────────────
    // Tier 1: identical base names. Tier 2: canonical forms equal (case,
    // " (1)" copy suffix, separator style). Tier 3: unique containment-prefix.
    // Anything below tier 1 is marked 'fuzzy' so the app can say "controle
    // nodig" — and an AMBIGUOUS candidate set never matches at all: no match
    // is honest, a guessed match cuts the wrong plate.
    const po = files.find((/** @type {{ kind: string; }} */ f) => f.kind === 'po') || null;

    // A FOLDER WITHOUT A SINGLE CAD FILE DESCRIBES NO PARTS.
    //
    // An order archive puts one folder per article beside a "Labels" folder of
    // 77 label sheets. Flattened, every one of those labels looks like a lone
    // drawing and becomes a project line of its own — 77 parts nobody ordered,
    // sitting between the real ones. The folder is the only thing that says
    // otherwise, and it is exactly the thing flattening throws away.
    //
    // Only files that came OUT OF AN ARCHIVE have a folder; a loose mailed
    // drawing keeps every bit of its old behaviour, including becoming a line
    // with an empty CAD column when the customer forgot the model.
    const foldersWithCad = new Set(
        files.filter((f) => f.kind === 'cad' && f.folder).map((f) => f.folder),
    );
    const skipped = new Map();
    const inSkippedFolder = (f) => {
        if (!f.folder || foldersWithCad.has(f.folder)) return false;
        skipped.set(f.folder, (skipped.get(f.folder) || 0) + 1);
        return true;
    };

    // TIER 0: AN ARTICLE FOLDER IS ONE PART, WHATEVER ITS FILES ARE CALLED.
    //
    // Grouping on the filename is right for a flat pile and wrong for a folder
    // tree, because inside a folder the names are free to vary: nine article
    // folders in one real order hold 'X.dxf' AND 'X (afschuining).dxf', which
    // read as names are two parts and read as a folder are one plate with a
    // chamfer. Measured against that customer's own line list, filename
    // grouping produced 85 lines where 77 were ordered; folder grouping
    // produced 76 — every one of them a line they actually placed.
    //
    // The folder only gets to speak when it says ONE thing: every CAD file in
    // it must belong to the same part. A folder holding two part numbers is a
    // folder that means nothing, and those files fall back to their names.
    const cadKeysByFolder = new Map();
    for (const f of files) {
        if (f.kind !== 'cad' || !f.folder) continue;
        const seen = cadKeysByFolder.get(f.folder) || new Set();
        seen.add(partKeyOf(f.name));
        cadKeysByFolder.set(f.folder, seen);
    }
    const partFolders = new Map();      // folder path → the part it stands for
    for (const [folder, keys] of cadKeysByFolder) {
        if (keys.size !== 1) continue;
        partFolders.set(folder, partNameForFolder(folder, [...keys][0]));
    }

    const groups = new Map();
    for (const f of files) {
        if (f.kind !== 'cad' && f.kind !== 'drawing') continue;
        if (f === po) continue;
        if (inSkippedFolder(f)) continue;
        const folderPart = f.folder ? partFolders.get(f.folder) : undefined;
        const key = folderPart === undefined ? canonicalBaseOf(f.name) : folderPart;
        const g = groups.get(key)
            || { key, cads: [], drawings: [], folder: folderPart === undefined ? '' : f.folder };
        (f.kind === 'cad' ? g.cads : g.drawings).push(f);
        groups.set(key, g);
    }
    // `meta` is what the FOLDER knew and the filename could not say. Defaults
    // come off the leading file, so a loose mailed pair keeps exactly the shape
    // it always had.
    /**
     * @param {string} matchStatus
     */
    const mkPair = (baseName, cad, drawing, matchStatus, meta = {}) => {
        const lead = cad || drawing;
        return {
            baseName,
            // The join key an order sheet can be matched on: no extension, no
            // operation. The sheet says '3010-010857' + variant '01'; the files
            // say '3010-010857-01 (afschuining).dxf'. Neither side can find the
            // other without one agreed spelling.
            partKey: meta.partKey || (lead ? partKeyOf(lead.name) : baseName),
            folder: meta.folder || (lead && lead.folder) || '',
            // Work instruction, never identity — 'afschuining', 'tappen'.
            operation: meta.operation || (lead ? operationOf(baseNameOf(lead.name)) : ''),
            cadName: cad ? cad.name : null,
            cadFile: cad ? cad.descriptor : null,
            drawingName: drawing ? drawing.name : null,
            drawingFile: drawing ? drawing.descriptor : null,
            role: cad && drawing ? PAIR_ROLES.BOTH : (cad ? PAIR_ROLES.CAD_ONLY : PAIR_ROLES.DRAWING_ONLY),
            matchStatus,
            // The CAD files this line did NOT pick. Names only: the bytes are
            // already attachment rows of the same conversation, and a second
            // descriptor per line is what pushed a 243-part result over the
            // 64 kB step-body ceiling.
            extraCad: meta.extraCad || [],
        };
    };
    const pairs = [];
    const loneCads = [];
    const loneDrawings = [];
    const prefer = cadPreferenceWith(step.cadPreferred);
    for (const g of groups.values()) {
        g.cads.sort((/** @type {{ name: string; }} */ a, /** @type {{ name: string; }} */ b) => {
            const byFormat = prefer(a.name) - prefer(b.name);
            if (byFormat) return byFormat;
            // Same format, so the NAME decides: the file that spells out the
            // operation is the deliverable. A folder '…-01 (Afschuining)' holds
            // the plain plate beside the chamfered one, and it is the chamfered
            // one that gets cut — their own line list picks it ten times out of
            // ten. Ties fall back to the name so the choice is reproducible.
            const opA = operationOf(baseNameOf(a.name)) ? 0 : 1;
            const opB = operationOf(baseNameOf(b.name)) ? 0 : 1;
            return opA !== opB ? opA - opB : a.name.localeCompare(b.name);
        });
        const cad = g.cads[0] || null;
        const drawing = g.drawings[0] || null;
        // Two CAD files carrying DIFFERENT operations is not a plate-and-its-
        // variant, it is '(links)' beside '(rechts)' — two plates the folder
        // happens to hold together. Pick one and say so; never quietly.
        const namedOps = new Set(g.cads.map((/** @type {{ name: string; }} */ c) => operationOf(baseNameOf(c.name))).filter(Boolean));
        const meta = {
            partKey: g.folder ? g.key : undefined,
            folder: g.folder || undefined,
            operation: (g.folder && operationOf(String(g.folder).split('/').pop())) || undefined,
            extraCad: g.cads.slice(1).map((c) => c.name),
        };
        if (cad && drawing) {
            // Inside a folder the two files need not share a name — the folder
            // already said they belong together, so comparing PARTS is the
            // honest test. Outside one, only an identical base name is exact.
            const exact = g.folder
                ? partKeyOf(cad.name) === partKeyOf(drawing.name)
                : cad.baseName === drawing.baseName;
            const status = namedOps.size > 1 ? 'controleren' : (exact ? 'exact' : 'fuzzy');
            pairs.push(mkPair(g.key, cad, drawing, status, meta));
        } else if (cad) {
            loneCads.push({ key: g.key, cad, used: false, meta, ambiguous: namedOps.size > 1 });
        } else if (drawing) {
            loneDrawings.push({ key: g.key, drawing, used: false, meta });
        }
    }
    for (const d of loneDrawings) {
        const hits = loneCads.filter((c) => !c.used && containsPrefix(d.key, c.key));
        if (hits.length === 1) {
            hits[0].used = true;
            d.used = true;
            pairs.push(mkPair(d.key, hits[0].cad, d.drawing, 'fuzzy', hits[0].meta));
        }
    }
    for (const c of loneCads) {
        if (!c.used) pairs.push(mkPair(c.key, c.cad, null, c.ambiguous ? 'controleren' : 'geen', c.meta));
    }
    for (const d of loneDrawings) {
        if (!d.used) pairs.push(mkPair(d.key, null, d.drawing, 'geen', d.meta));
    }

    // WITHOUT A FOLDER, TWO NAMES THAT DIFFER ONLY BY THEIR OPERATION ARE A
    // QUESTION, NOT AN ANSWER.
    //
    // In a flat archive 'plaat-01.dxf' and 'plaat-01 (afschuining).dxf' become
    // two groups and there is nothing to arbitrate between them: they may be
    // one plate cut once, and '(links)'/'(rechts)' may be two. Merging would
    // cut one plate too few, splitting one too many — so both lines stand and
    // both are flagged for a human.
    const looseByPart = new Map();
    for (const pair of pairs) {
        if (pair.folder) continue;
        const share = looseByPart.get(pair.partKey) || [];
        share.push(pair);
        looseByPart.set(pair.partKey, share);
    }
    for (const share of looseByPart.values()) {
        if (share.length < 2) continue;
        for (const pair of share) pair.matchStatus = 'controleren';
    }
    return { po, pairs, skipped };
}

module.exports = { PAIR_ROLES, pairFiles };

/** @typedef {{ key: string, cads: import('./attachmentRows').IntakeFile[], drawings: import('./attachmentRows').IntakeFile[], folder: string }} PairGroup */
