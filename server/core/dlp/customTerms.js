// @typecheck
/**
 * Custom sensitive-term scanner for the org Privacy Shield.
 *
 * NO LONGER ON THE RUNTIME PATH. The terms are now the org's own data types
 * ("Your own data", core/privacy/customTypes): migrated to `words`/`pattern`
 * types and run inside detectPii everywhere the shield runs, not only in chat
 * DLP and routines. This scanner stays for one release as the PARITY
 * REFERENCE (core/privacy/customTypes/parity.test.js runs its old fixtures
 * through both) and is removed with the `customSensitiveTerms` mirror.
 *
 * Admins configure a list of terms (regex or literal) that should be treated
 * like PII — redacted or blocked before prompts leave the organisation.
 * Typical examples: project codenames, contract-number patterns, customer
 * list entries, internal product names.
 *
 * Performance: terms are compiled into union regexes per org and cached until
 * the admin saves a change (the route calls `invalidate(orgId)`).
 *
 * ── Why two unions rather than one ────────────────────────────────────────
 * Case-sensitive and case-insensitive terms cannot share a regex: V8 rejects
 * inline flag groups like `(?i:...)` nested inside a named capture group. The
 * previous code worked around that by compiling everything `gi` and then
 * re-testing each match against an ANCHORED recompile of the single pattern
 * (`^(?:pattern)$`). That was wrong twice over: a pattern carrying its own
 * anchors or lookarounds fails the re-test and its legitimate match is silently
 * dropped, and the recompile happened once PER MATCH, so an untrusted regex was
 * rebuilt as many times as it hit.
 *
 * Bucketing by case-sensitivity removes the post-filter entirely: each term is
 * matched under exactly the flags it asked for, once.
 */

// In-memory cache: orgId → { unions: [...], termIndex: [...] }
const log = require('../../telemetry/log');
const _cache = new Map();

/**
 * Hard bound on how much text a single scan will walk.
 *
 * These patterns are admin-authored and run on the main event loop against
 * arbitrary user input, so an unbounded scan is an availability risk on its own
 * — before catastrophic backtracking is even considered. Beyond the cap we scan
 * a bounded PREFIX and report it, mirroring the partial-scan vocabulary
 * detectPii already uses for oversize input, rather than silently truncating.
 */
const MAX_SCAN_CHARS = 100_000;

function escapeRegex(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The regex source for a term, honouring literal-vs-regex. */
function _sourceFor(term) {
    return term.type === 'literal' ? escapeRegex(term.pattern) : term.pattern;
}

/**
 * Compile an array of term configs into union regexes plus a lookup table (so
 * a match can be attributed to the term that produced it).
 *
 * ── The bug this shape exists to prevent ──────────────────────────────────
 * `termIndex` is built with `continue` skips (a term missing a pattern or
 * label, or one whose regex doesn't compile). The old code then built the
 * union in a SECOND pass — `termIndex.map((entry, i) => ... terms[i] ...)` —
 * so after any skip, entry *i* was paired with a DIFFERENT term's pattern.
 *
 * Observed with `[{no label, 'GEHEIM'}, {'Projectnaam', 'Aurora'}, {'Klantcode', 'KC-\d{4}'}]`:
 * `GEHEIM` — a term deliberately skipped — was scanned and reported as
 * `Projectnaam`, `Aurora` was reported as `Klantcode`, and `KC-\d{4}` was never
 * scanned at all. A term the admin never labelled got redacted under someone
 * else's name while a term they did configure was silently ignored.
 *
 * The fix is structural, not a patch: one loop, and the union is built from the
 * same `source` that was validated and recorded. There is no second pass to get
 * out of step, and a pattern that failed validation can no longer reach a union.
 *
 * @param {Array} terms  [{ id, label, pattern, caseSensitive, type: 'regex'|'literal' }]
 * @returns {{ unions: Array<{compiled: RegExp|null, entries: Array}>, termIndex: Array }}
 */
function _compile(terms) {
    if (!Array.isArray(terms) || terms.length === 0) {
        return { unions: [], termIndex: [] };
    }

    // Two buckets: `gi` for the default, `g` for terms that asked for exact case.
    const buckets = {
        i: { flags: 'gi', parts: [], entries: [] },
        s: { flags: 'g', parts: [], entries: [] },
    };

    for (const term of terms) {
        if (!term?.pattern || !term?.label) continue;

        const caseSensitive = !!term.caseSensitive;
        const bucket = caseSensitive ? buckets.s : buckets.i;
        const source = _sourceFor(term);

        // Compile individually first so a bad pattern is rejected cheaply and,
        // more importantly, can never reach the union.
        try {
            new RegExp(source, bucket.flags);
        } catch (err) {
            log.warn(`[CustomTerms] Skipping invalid term "${term.label}": ${err.message}`);
            continue;
        }

        // Group names must be unique within a regex; number within the bucket.
        const groupName = `t${bucket.entries.length}`;
        const entry = {
            id: term.id || `${caseSensitive ? 's' : 'i'}${groupName}`,
            label: term.label,
            pattern: term.pattern,
            type: term.type === 'literal' ? 'literal' : 'regex',
            caseSensitive,
            groupName,
            source,
        };

        // Same iteration, same `source` — this pairing cannot drift.
        bucket.parts.push(`(?<${groupName}>${source})`);
        bucket.entries.push(entry);
    }

    const unions = [];
    const termIndex = [];
    for (const bucket of [buckets.i, buckets.s]) {
        if (bucket.entries.length === 0) continue;
        termIndex.push(...bucket.entries);
        let compiled = null;
        try {
            compiled = new RegExp(bucket.parts.join('|'), bucket.flags);
        } catch (err) {
            // Individually-valid patterns can still fail to combine (duplicate
            // group names inside admin-supplied sources, for instance). Fall
            // back to per-term scanning for this bucket rather than dropping it.
            log.error(`[CustomTerms] Union compile failed (${bucket.flags}), falling back to per-term scanning:`, err.message);
        }
        unions.push({ compiled, entries: bucket.entries, flags: bucket.flags });
    }

    return { unions, termIndex };
}

function _getCompiled(orgId, terms) {
    const cached = _cache.get(orgId);
    if (cached) return cached;
    const compiled = _compile(terms);
    _cache.set(orgId, compiled);
    return compiled;
}

/**
 * Drop the cached compile for an org. Call from the Privacy Shield PUT route.
 */
function invalidate(orgId) {
    if (orgId) _cache.delete(orgId);
}

/** Push every match of `re` in `text`, attributing via `resolve(match)`. */
function _collect(re, text, resolve, findings) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
        const entry = resolve(m);
        if (entry) {
            findings.push({
                category: 'CustomTerm',
                label: entry.label,
                start: m.index,
                end: m.index + m[0].length,
                match: m[0],
                termId: entry.id,
            });
        }
        // Zero-width matches would otherwise loop forever.
        if (m[0].length === 0) re.lastIndex++;
    }
}

/**
 * Scan `text` for any of the org's configured sensitive terms.
 *
 * @param {string} text
 * @param {string} orgId
 * @param {Array} terms  Raw term config from org Privacy Shield
 * @returns {{ findings: Array, partial: boolean, processedChars: number, totalChars: number }}
 *          `findings` entries are
 *          { category, label, start, end, match, termId }.
 */
function scanCustomTerms(text, orgId, terms) {
    const totalChars = typeof text === 'string' ? text.length : 0;
    const empty = { findings: [], partial: false, processedChars: 0, totalChars };
    if (!text || !orgId || !Array.isArray(terms) || terms.length === 0) return empty;

    // Bounded prefix rather than an unbounded walk — see MAX_SCAN_CHARS.
    const partial = totalChars > MAX_SCAN_CHARS;
    const scanned = partial ? text.slice(0, MAX_SCAN_CHARS) : text;
    if (partial) {
        log.warn(`[CustomTerms] org=${orgId} input ${totalChars} chars exceeds the ${MAX_SCAN_CHARS} scan budget — scanning the prefix only; the tail is NOT covered`);
    }

    const { unions } = _getCompiled(orgId, terms);
    const findings = [];

    for (const union of unions) {
        if (union.compiled) {
            _collect(union.compiled, scanned, (m) => {
                const groups = m.groups || {};
                return union.entries.find(e => groups[e.groupName] !== undefined) || null;
            }, findings);
            continue;
        }
        // Per-term fallback for a bucket whose union wouldn't compile. Slower,
        // but every term still gets scanned under its own flags.
        for (const entry of union.entries) {
            let re;
            try {
                re = new RegExp(entry.source, union.flags);
            } catch { continue; }
            _collect(re, scanned, () => entry, findings);
        }
    }

    findings.sort((a, b) => a.start - b.start || b.end - a.end);
    return { findings, partial, processedChars: scanned.length, totalChars };
}

module.exports = {
    scanCustomTerms,
    invalidate,
    MAX_SCAN_CHARS,
    _compile, // exported for tests
};
