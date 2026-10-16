// @typecheck
/**
 * Paths a dry run only PRETENDED to write.
 *
 * A dry run simulates side-effect steps (nextcloud_upload_file, _move, _copy,
 * _create_folder, ...) but dispatches read-only ones live. A read of a path
 * that only a simulated step would have produced therefore answers "not found",
 * which is a step error since 2026-09-12 and failed every dry run that creates
 * a file and reads it back. The runner records the paths the simulated steps
 * would have produced here, and a not-found read ON or BELOW one of them falls
 * back to the sample. A path no earlier step touched still fails.
 *
 * Accepted trade-off: an idempotent create_folder of a folder that already
 * exists also covers its children, so a typo below it falls back to a sample.
 *
 * The set lives on ctx._simulatedPaths, created once in buildRunContext
 * (runContext.js) and shared by reference with every ctx copy (loop bodies,
 * parallel branches, layers); this module never creates it.
 */
const { classifyNextcloudError } = require('../integrations/nextcloudErrorClassifier');


/** Tool name -> the argument naming the path it would have created. */
const WRITTEN_PATH_ARG = {
    nextcloud_upload_file: 'path',
    nextcloud_create_folder: 'path',
    nextcloud_create_document: 'path',
    nextcloud_create_spreadsheet: 'path',
    nextcloud_create_presentation: 'path',
    nextcloud_move: 'destination',
    nextcloud_copy: 'destination',
    nextcloud_convert_file: 'destination',
    nextcloud_restore_from_trash: 'originalPath',
    // A folder: whatever the attachment is called lands below it.
    nextcloud_mail_save_attachment: 'targetPath',
};

/** Office creators append their extension when it is missing: cover that name too. */
const DEFAULT_EXT = {
    nextcloud_create_presentation: 'pptx',
    nextcloud_create_spreadsheet: 'xlsx',
    nextcloud_create_document: 'docx',
};

/** '/X//a/' -> '/X/a'; null for anything that is not a usable path. */
function normalisePath(p) {
    if (typeof p !== 'string') return null;
    const parts = p.split('/').filter(Boolean);
    return parts.length ? `/${parts.join('/')}` : null;
}

/** @param {{ _simulatedPaths?: Set<string> }} ctx @param {string} tool @param {Record<string, unknown>} inputs */
function recordSimulatedWrite(ctx, tool, inputs) {
    const set = ctx && ctx._simulatedPaths;
    if (!set) return;
    const arg = WRITTEN_PATH_ARG[tool];
    const path = arg ? normalisePath(inputs && inputs[arg]) : null;
    if (!path) return;
    set.add(path);
    const ext = DEFAULT_EXT[tool];
    if (ext && !path.toLowerCase().endsWith(`.${ext}`)) set.add(`${path}.${ext}`);
}

/** True when `path` is a simulated write or lies below one (segment-wise, so /X/ab is not below /X/a). */
function isUnderSimulatedPath(ctx, path) {
    const p = normalisePath(path);
    const set = ctx && ctx._simulatedPaths;
    if (!p || !set) return false;
    for (const w of set) {
        if (p === w || p.startsWith(`${w}/`)) return true;
    }
    return false;
}

/** A Nextcloud tool's soft "not found" answer, as the shared classifier reads it. */
function isNotFoundError(tool, error) {
    if (typeof error !== 'string' || !String(tool).startsWith('nextcloud_')) return false;
    return classifyNextcloudError(error).code === 'NOT_FOUND';
}

module.exports = { recordSimulatedWrite, isUnderSimulatedPath, isNotFoundError, normalisePath };
