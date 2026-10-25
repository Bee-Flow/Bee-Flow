// @typecheck strict
/**
 * file_intake — the per-intake bounds. One module, so every phase reads the
 * same numbers.
 */

'use strict';

// Sized for a real order, not for the first one we saw. These were 25/40/60,
// which is a twenty-part package — and then an RFQ arrived as one archive of 77
// article folders, each holding a .dxf and a .pdf. 154 entries.
//
// The per-intake ceiling is the one that bites twice: after expansion those 154
// entries ARE attachment rows of the conversation, so a second press locates
// 157 rows. At 25 the button silently stopped being idempotent — it would
// re-pair a fifth of the order and leave the rest untouched.
const MAX_FILES_PER_INTAKE = 500;

// Zip expansion bounds. Generous enough for ~250 parts and still small enough
// that a crafted archive cannot turn one button press into a memory or storage
// incident — the byte ceiling, not the count, is what actually bounds that.
const MAX_ZIP_ENTRIES = 500;
// How deep we follow an archive that holds an archive. 1 is the mailed file, 2
// is the zip inside it — which is what a forwarded order looks like, and what
// "I zipped the project folder" produces when that folder already had a zip in
// it. Deeper than that is not a packing habit, it is a nesting bomb.
const MAX_ARCHIVE_DEPTH = 2;
const MAX_ZIP_TOTAL_BYTES = 100 * 1024 * 1024; // uncompressed, per intake
const MAX_TOTAL_FILES = 500;                   // loose + expanded, per intake

module.exports = {
    MAX_FILES_PER_INTAKE,
    MAX_ZIP_ENTRIES,
    MAX_ARCHIVE_DEPTH,
    MAX_ZIP_TOTAL_BYTES,
    MAX_TOTAL_FILES,
};
