// @typecheck strict

const { isObject, deepClone, claimText } = require('./portabilityClaims');

const APP_FORMAT = 'beeflow.app';

const APP_SCHEMA_VERSION = 1;

/**
 * Every version this server can still READ, newest last. See templatePortability.
 * @type {readonly unknown[]}
 */
const APP_SUPPORTED_VERSIONS = [1];

/**
 * The archive's own ceilings.
 *
 * These are NOT the engine's limits (DATA_LIMITS allows 100k rows per table and
 * 5000 attachments per app) and they are deliberately far below them. An
 * archive arrives as one JSON body that has to be parsed whole before a single
 * question about it can be answered, and the express body cap (20 MB) is the
 * real wall. Refusing at a number this module names, with a sentence saying
 * which number, beats being killed by a parser with none.
 *
 * They are also what stops a pathological file: one table with a million rows,
 * or a hundred thousand one-byte "files", costs an install loop far more than
 * its size suggests.
 */
const MAX_RECORDS_PER_TABLE = 10_000;

const MAX_RECORDS_TOTAL = 25_000;

const MAX_FILES = 2_000;

const MAX_FILE_BYTES = 25 * 1024 * 1024;

const MAX_CONTENT_BYTES = 16 * 1024 * 1024;

/** How long a claim out of a file may be before it is cut. */
const MAX_CLAIM_CHARS = { id: 64, name: 200, text: 400, ref: 64, key: 63 };

const SHA256_RE = /^[0-9a-f]{64}$/;

/** What the design half of an archive is allowed to carry. Nothing else does. */
const TEMPLATE_FIELDS = ['definition', 'dataModel', 'datasets', 'seedPeople'];

/**
 * A file NAME, as a name and never as a path.
 *
 * The name is what a download serves and what proposes the MIME type, so a
 * separator in it is either a mistake or an attempt. Both are answered the same
 * way: keep the last segment, drop the control characters, cap it. A name that
 * is nothing but separators and dots leaves null and the entry is refused —
 * there is no honest file called `../`.
 * @param {unknown} value
 */
function claimFileName(value) {
    if (typeof value !== 'string') return null;
    const flat = value.replace(/[\u0000-\u001f\u007f]/g, '').split(/[\\/]/).pop() || '';
    const trimmed = flat.trim().replace(/^\.+$/, '');
    return trimmed ? trimmed.slice(0, MAX_CLAIM_CHARS.name) : null;
}

/**
 * The `source` block, as a normalised CLAIM. One place decides what a
 * provenance assertion may contain, so no reader downstream ever touches
 * `envelope.source.orgName` raw.
 * @param {unknown} envelope
 */
function readSource(envelope) {
    const raw = isObject(envelope) && isObject(envelope.source) ? envelope.source : {};
    return {
        appId: claimText(raw.appId, MAX_CLAIM_CHARS.id),
        orgId: claimText(raw.orgId, MAX_CLAIM_CHARS.id),
        orgName: claimText(raw.orgName, MAX_CLAIM_CHARS.name),
        productVersion: claimText(raw.productVersion, MAX_CLAIM_CHARS.id),
    };
}

module.exports = { APP_FORMAT, APP_SCHEMA_VERSION, APP_SUPPORTED_VERSIONS, MAX_RECORDS_PER_TABLE, MAX_RECORDS_TOTAL, MAX_FILES, MAX_FILE_BYTES, MAX_CONTENT_BYTES, MAX_CLAIM_CHARS, SHA256_RE, TEMPLATE_FIELDS, isObject, deepClone, claimText, claimFileName, readSource };
