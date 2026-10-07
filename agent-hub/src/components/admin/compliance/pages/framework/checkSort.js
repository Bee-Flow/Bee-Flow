/**
 * checkSort — the pure half of the framework checks table (artboard 1b).
 *
 * Which rows a framework page shows, in which order, under which pill, and
 * what the actions column may offer for a row. No React, no i18n text: the
 * component layer passes `t` in where a title is needed for search.
 *
 * A check belongs to a framework page when the regulation is its HOME
 * (`check.regulation`) or when the registry tagged it as counting for that
 * framework too (`check.frameworks[]`, be-registry-runner). The GDPR breach
 * check therefore appears on the ISO page as well, with a "also counts for
 * GDPR Art. 33" line under its title — one measurement, several ledgers.
 */
import { affectedProjects } from './AffectedProjects';
import { resolveSection, DEFAULT_SECTION } from '../../sections';

/**
 * The identity of ONE row: a per-source check has a row per subject (scope),
 * so open state, focus and the busy spinners key on check + scope, never on
 * the check id alone (one click used to open all four DPIA rows).
 */
export function rowKeyOf(check) {
    return `${check?.check_id ?? ''}:${check?.scope_id || ''}`;
}

/**
 * The row the overview sent us to. `focusId` is a row key ("id:scope") or a
 * bare check id; a bare id opens the FIRST row of that check in the order
 * given (the table passes its sorted list, so that is the most urgent one).
 * null when no row matches.
 */
export function focusRowKey(list, focusId) {
    if (!focusId || !Array.isArray(list)) return null;
    const wanted = String(focusId);
    const exact = list.find((c) => c && rowKeyOf(c) === wanted);
    if (exact) return rowKeyOf(exact);
    const first = list.find((c) => c && c.check_id === wanted);
    return first ? rowKeyOf(first) : null;
}

/**
 * Is THIS row the one the host is busy with (rerun / auto-fix spinner)? The
 * host's id may be a row key (a host that knows rows) or a check id
 * (useComplianceCore runs whole checks); for a check id, the row whose
 * button was clicked (`askedKey`) spins, or every row of the check when the
 * run was started elsewhere.
 */
export function isBusyRow(activeId, check, askedKey) {
    if (!activeId || !check) return false;
    const key = rowKeyOf(check);
    if (activeId === key) return true;
    if (activeId !== check.check_id) return false;
    return askedKey && askedKey.startsWith(`${check.check_id}:`) ? askedKey === key : true;
}

/**
 * Trail rows that belong to one row's subject (`field` is `scope_id` on a
 * history row, `subject_id` on an evidence row); a global row keeps them all.
 * A row that does not carry the field at all cannot be told apart and is kept.
 */
export function ofSubject(rows, scopeId, field = 'scope_id') {
    const list = Array.isArray(rows) ? rows : [];
    if (!scopeId) return list;
    return list.filter((r) => r && (!(field in r) || String(r[field] ?? '') === String(scopeId)));
}

function nonEmpty(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * What a per-subject row is about, by name: the runner's `subject_label`,
 * else the agent or automation name a check wrote itself, else the one
 * project the finding is about (its current name, resolved by the server).
 * null when the row names no single subject.
 */
export function subjectLabel(check) {
    const ev = check?.evidence && typeof check.evidence === 'object' ? check.evidence : {};
    const named = nonEmpty(ev.subject_label) || nonEmpty(ev.agent_name) || nonEmpty(ev.automation_name);
    if (named) return named;
    const projects = check ? affectedProjects(check) : [];
    return projects.length === 1 ? projects[0].name : null;
}

/** by_status order: what is broken first, what needs a look next, then the quiet rows. */
export const STATUS_ORDER = Object.freeze({ fail: 0, warn: 1, pass: 2, not_applicable: 3, pending: 4 });

/** Severity order inside one status band — the weight a row carries in the score. */
export const SEVERITY_ORDER = Object.freeze({ critical: 0, high: 1, medium: 2, low: 3 });

export const SORT_MODES = Object.freeze(['by_status', 'by_article']);

export const STATUS_PILLS = Object.freeze(['all', 'fail', 'warn', 'pass', 'not_applicable']);

/** The pill tone per filter value — `all` is the neutral pill, n/a the muted one. */
export const PILL_TONE = Object.freeze({
    all: 'neutral', fail: 'error', warn: 'warning', pass: 'success', not_applicable: 'muted',
});

/** An OPEN row is one that asks for work: failing or needing attention. */
export function isOpen(status) {
    return status === 'fail' || status === 'warn';
}

/** Home regulation OR tagged for it via `frameworks[]`. */
export function belongsToRegulation(check, regulation) {
    if (!check || !regulation) return false;
    if (check.regulation === regulation) return true;
    return Array.isArray(check.frameworks) && check.frameworks.some((f) => f && f.regulation === regulation);
}

export function checksForRegulation(checks, regulation) {
    if (!Array.isArray(checks)) return [];
    return checks.filter((c) => belongsToRegulation(c, regulation));
}

/**
 * The other ledgers a row counts for — every `frameworks[]` entry whose
 * regulation is not the page's own, deduplicated on regulation + ref. The
 * row's home article is included when the page is NOT its home (the ISO page
 * says "also counts for GDPR Art. 33").
 */
export function otherFrameworkRefs(check, regulation) {
    if (!check) return [];
    const seen = new Set();
    const out = [];
    const push = (reg, ref) => {
        if (!reg || !ref || reg === regulation) return;
        const key = `${reg}:${ref}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ regulation: reg, ref: String(ref) });
    };
    if (check.regulation && check.regulation !== regulation) push(check.regulation, check.article);
    if (Array.isArray(check.frameworks)) for (const f of check.frameworks) if (f) push(f.regulation, f.ref);
    return out;
}

/**
 * The article this row shows on THIS page: the ref the registry tagged for
 * the page's regulation, else the home article.
 */
export function articleForRegulation(check, regulation) {
    if (!check) return '';
    if (check.regulation !== regulation && Array.isArray(check.frameworks)) {
        const hit = check.frameworks.find((f) => f && f.regulation === regulation && f.ref);
        if (hit) return String(hit.ref);
    }
    return check.article == null ? '' : String(check.article);
}

/**
 * The numbers in an article ref, in order: "32" → [32], "A.8.24" → [8, 24],
 * "5(1)(c)" → [5, 1], "cl 9.2" → [9, 2]. Segment-wise so A.5.9 sorts before
 * A.5.24 (a float would put 5.24 first). Empty when the ref has no number.
 */
export function articleKey(article) {
    return (String(article ?? '').match(/\d+/g) || []).map((n) => parseInt(n, 10));
}

/** Leading number of an article ref ("32" → 32, "A.8.24" → 8); NaN when none. */
export function articleNumber(article) {
    const k = articleKey(article);
    return k.length ? k[0] : NaN;
}

function compareArticle(a, b) {
    const ka = articleKey(a); const kb = articleKey(b);
    if (ka.length === 0 || kb.length === 0) return String(a ?? '').localeCompare(String(b ?? ''));
    for (let i = 0; i < Math.max(ka.length, kb.length); i += 1) {
        const x = ka[i] ?? -1; const y = kb[i] ?? -1;
        if (x !== y) return x - y;
    }
    return String(a ?? '').localeCompare(String(b ?? ''));
}

function rank(table, key, fallback) {
    const r = table[key];
    return r === undefined ? fallback : r;
}

export function compareByStatus(a, b, regulation) {
    const sa = rank(STATUS_ORDER, a.status, 5); const sb = rank(STATUS_ORDER, b.status, 5);
    if (sa !== sb) return sa - sb;
    const va = rank(SEVERITY_ORDER, a.severity, 4); const vb = rank(SEVERITY_ORDER, b.severity, 4);
    if (va !== vb) return va - vb;
    return compareArticle(articleForRegulation(a, regulation), articleForRegulation(b, regulation));
}

export function compareByArticle(a, b, regulation) {
    const c = compareArticle(articleForRegulation(a, regulation), articleForRegulation(b, regulation));
    if (c !== 0) return c;
    return compareByStatus(a, b, regulation);
}

/** A sorted COPY; unknown mode → by_status. */
export function sortChecks(list, mode, regulation) {
    const cmp = mode === 'by_article' ? compareByArticle : compareByStatus;
    return [...(Array.isArray(list) ? list : [])].sort((a, b) => cmp(a, b, regulation));
}

export function filterByStatus(list, pill) {
    const rows = Array.isArray(list) ? list : [];
    if (!pill || pill === 'all') return rows;
    return rows.filter((c) => c.status === pill);
}

/**
 * The status pills worth showing: `all`, every status that has rows, and the
 * active one even at 0 (so a filter that emptied after a run can still be
 * left). Without counts (still loading) every pill shows, uncounted.
 */
export function visiblePills(counts, active) {
    if (!counts) return [...STATUS_PILLS];
    return STATUS_PILLS.filter((v) => v === 'all' || v === active || (counts[v] ?? 0) > 0);
}

/** Counts for the five pills; `all` is the whole list. */
export function countByStatus(list) {
    const rows = Array.isArray(list) ? list : [];
    const counts = { all: rows.length, fail: 0, warn: 0, pass: 0, not_applicable: 0 };
    for (const c of rows) if (c.status in counts && c.status !== 'all') counts[c.status] += 1;
    return counts;
}

/**
 * Free-text match over title, id, article, details and the subject's name. `titleOf(check)`
 * gives the translated title so the search speaks the interface language.
 */
export function matchesSearch(check, query, titleOf = () => '') {
    const q = String(query ?? '').trim().toLowerCase();
    if (!q) return true;
    const hay = [
        titleOf(check), check.check_id, check.article, check.details, subjectLabel(check),
        ...(Array.isArray(check.frameworks) ? check.frameworks.map((f) => f && `${f.regulation} ${f.ref}`) : []),
    ].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
}

export function filterBySearch(list, query, titleOf) {
    const rows = Array.isArray(list) ? list : [];
    return rows.filter((c) => matchesSearch(c, query, titleOf));
}

/**
 * What the remediation link of a row points at.
 *   admin/compliance/settings      → { kind:'settings' }           "Configure ↗"
 *   admin/compliance/<section>[/x] → { kind:'section', sectionId }  "Go to <section> →"
 *   anything else (admin escape)   → { kind:'external', path }      "Open fix ↗"
 * null when there is no link.
 */
export function resolveRemediation(link) {
    const path = String(link ?? '').replace(/^\//, '').trim();
    if (!path) return null;
    const m = path.match(/^admin\/compliance\/([^/?#]+)(?:\/([^?#]+))?/);
    if (m) {
        const sectionId = resolveSection(decodeURIComponent(m[1]));
        // An unknown compliance id resolves to the overview — that is not a
        // fix target, so it degrades to a plain external link.
        if (sectionId === DEFAULT_SECTION && m[1] !== DEFAULT_SECTION) return { kind: 'external', path };
        if (sectionId === 'settings') return { kind: 'settings', sectionId, path };
        return { kind: 'section', sectionId, subId: m[2] ? decodeURIComponent(m[2]) : undefined, path };
    }
    return { kind: 'external', path };
}

/**
 * Whether the page can follow a resolved link: compliance sections need the
 * hub's `navigate(sectionId)`, an admin escape (`admin/monitoring/…`) needs
 * the raw-path `onNavigate`. A button for a link nobody can follow is not
 * rendered.
 */
export function canFollow(rem, { navigate, onNavigate } = {}) {
    if (!rem) return false;
    if (rem.kind === 'external') return typeof onNavigate === 'function';
    return typeof navigate === 'function';
}

/**
 * How many things an auto-fix would touch — the registry does not send a
 * count yet, so the evidence's affected list is the source. null = unknown
 * (render "Auto-fix" without a number, never "· 0").
 */
export function autoFixCount(check) {
    if (!check) return null;
    if (Number.isFinite(check.auto_fix_count)) return check.auto_fix_count;
    const ev = check.evidence;
    if (ev && typeof ev === 'object') {
        for (const key of ['missing_disclosure', 'affected', 'items']) {
            if (Array.isArray(ev[key])) return ev[key].length;
        }
    }
    return null;
}

/** ms of a date-ish value or null. */
export function toMs(value) {
    if (value == null || value === '') return null;
    const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isNaN(ms) ? null : ms;
}

function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * The "last run" cell: `HH:mm` when the run was today, a short date
 * otherwise (with the year only when it differs). null when unknown.
 */
export function formatRunAt(value, { now = Date.now(), locale = undefined } = {}) {
    const ms = toMs(value);
    if (ms === null) return null;
    const d = new Date(ms); const n = new Date(now);
    try {
        if (sameDay(d, n)) {
            return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
        }
        const opts = { day: 'numeric', month: 'short' };
        if (d.getFullYear() !== n.getFullYear()) opts.year = '2-digit';
        return new Intl.DateTimeFormat(locale, opts).format(d);
    } catch {
        return d.toISOString().slice(0, 10);
    }
}

/** The evidence-chain hash as the table shows it: first 12 hex characters, or null. */
export function shortHash(hash) {
    const h = String(hash ?? '').replace(/^sha256:/i, '');
    return h ? h.slice(0, 12) : null;
}

/** The framework catalogue id for a regulation code (`ISO27001` → `iso27001`, `DATA_ACT` → `data_act`). */
export function frameworkIdOf(regulation) {
    return regulation ? String(regulation).toLowerCase() : null;
}
