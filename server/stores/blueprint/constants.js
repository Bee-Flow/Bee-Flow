// @typecheck strict
/**
 * Blueprint store limits and vocabularies: the ceilings every writer checks,
 * the release channels and payload kinds, the deployment statuses the
 * pipeline prune reads, and the ref-ledger patterns. Leaf module.
 */

'use strict';

// A Solution is many entities, so this is deliberately larger than one app's
// 4 MB — but bounded, because an unbounded table of multi-megabyte JSONB blobs
// is a storage problem whatever it contains.
const MAX_BLUEPRINT_BYTES = 16 * 1024 * 1024;

// A gallery is a place you choose from. A few hundred entries is a search
// problem, not a gallery.
const MAX_BLUEPRINTS_PER_ORG = 100;

// How many publications per project are kept. Every row carries a full
// manifest, so the history is expensive; twenty is enough to look back on and
// small enough to keep. NOTE: this is a cap on the rows that NOTHING holds —
// see `_pruneReleases`, which leaves held rows out of the count and so lets the
// table grow past 20 on purpose.
const MAX_RELEASES_PER_PROJECT = 20;

// Pipeline releases are cut far more often than gallery publications (every
// "send to UAT"), so their own, larger cap. Same rule as above: rows a stage or
// a deployment still points at are outside the count.
const MAX_PIPELINE_RELEASES_PER_PROJECT = 50;

// The most pipeline releases one listing returns; the table may hold more than
// the cap because held rows are never pruned.
const MAX_LISTED_PIPELINE_RELEASES = 200;

// A release note is a note, not an attachment. The manifest has its own (much
// larger) ceiling; without a bound of its own a note could get around that
// ceiling by riding along in the same row.
const MAX_NOTES_BYTES = 64 * 1024;

// All payloads of one pipeline release together (reference rows are capped at
// 8 MB per release upstream; the KB listings are small). The store's own bound,
// so no caller can turn this table into a blob store.
const MAX_RELEASE_PAYLOAD_BYTES = 16 * 1024 * 1024;

/** What `solution_release_payloads` may hold (D20). Mirrors the table's CHECK. */
const RELEASE_PAYLOAD_KINDS = Object.freeze(['reference_rows', 'knowledge_listing']);

const RELEASE_CHANNELS = Object.freeze(['gallery', 'pipeline']);

// A deployment in one of these states no longer needs its release row for
// itself. Everything else (including a status added later) holds the row.
const TERMINAL_DEPLOYMENT_STATUSES = Object.freeze([
    'rejected', 'succeeded', 'succeeded_with_warnings', 'failed', 'cancelled',
]);
const SUCCEEDED_DEPLOYMENT_STATUSES = Object.freeze(['succeeded', 'succeeded_with_warnings']);

// Ref prefixes the ledger knows on its own: a connection is a binding slot, not
// a manifest entity kind, so no caller's prefix table carries it.
const BUILTIN_REF_PREFIX = Object.freeze({ connection: 'cn' });
const REF_PREFIX_RE = /^[a-z][a-z0-9]{0,15}$/;
const REF_RE = /^([a-z][a-z0-9]{0,15})_(\d+)$/;

const MAX_REQUEST_KEY_LENGTH = 200;

module.exports = {
    MAX_BLUEPRINT_BYTES,
    MAX_BLUEPRINTS_PER_ORG,
    MAX_RELEASES_PER_PROJECT,
    MAX_PIPELINE_RELEASES_PER_PROJECT,
    MAX_LISTED_PIPELINE_RELEASES,
    MAX_NOTES_BYTES,
    MAX_RELEASE_PAYLOAD_BYTES,
    RELEASE_PAYLOAD_KINDS,
    RELEASE_CHANNELS,
    TERMINAL_DEPLOYMENT_STATUSES,
    SUCCEEDED_DEPLOYMENT_STATUSES,
    BUILTIN_REF_PREFIX,
    REF_PREFIX_RE,
    REF_RE,
    MAX_REQUEST_KEY_LENGTH,
};
