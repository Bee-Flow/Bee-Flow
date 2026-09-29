/**
 * Shared `status`/`pii` document-filter validation.
 *
 * Both routes/knowledgeBases/documents.js (the KB-wide list) and
 * routes/knowledgeBases/sources.js (one source's documents) filter on the
 * same two fields, against the same store vocabulary
 * (stores/knowledgeBases.js's DOC_STATUSES / PII_STATUSES): an unknown value
 * must be refused, not silently dropped from the filter list — the store
 * drops what it does not recognise, and with nothing left in the list it
 * adds no clause at all, so a typo'd `?status=eror` came back with every
 * document under a 200. Each route used to carry its own copy of this check;
 * one implementation here is the one the store's vocabulary can drift under
 * without the two routes drifting from each other.
 */

const { z } = require('zod');
const kbStore = require('../../stores/knowledgeBases');

const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

// Read at request time, not captured once at require-time: the store owns
// these lists, and a test that stands in for the store need not repeat them.
const docStatuses = () => kbStore.DOC_STATUSES || [];
const piiFilters = () => [...(kbStore.PII_STATUSES || []), 'found'];

/**
 * Comma-separated, like the store reads it — every entry must be a real
 * status, because an empty list after filtering is no filter at all.
 */
const statusFilter = () => worded('status must be text.').trim()
    .refine((v) => v.split(',').every((s) => docStatuses().includes(s.trim())),
        () => ({ message: `status is one or more of: ${docStatuses().join(', ')} (comma-separated).` }));

const piiFilter = () => worded('pii must be text.').trim()
    .refine((v) => piiFilters().includes(v), () => ({ message: `pii is one of: ${piiFilters().join(', ')}.` }));

module.exports = { docStatuses, piiFilters, statusFilter, piiFilter };
