/**
 * What the compliance phase SHOWS, worked out from what the review found.
 * Pure, so the wording and the arithmetic can be pinned without a DOM.
 *
 * The problem this solves is tone. A list of orange triangles reads as "your
 * build is broken", which is not what a review of a fresh build means and not
 * what the room should take away. So: a verdict first (what was checked, what
 * came back clean), then the things to tidy up, with the severity as a WORD in
 * the phase's own vocabulary rather than a colour shouting on its own.
 */

import { toneOfSeverity } from '../../../../shared/statusTone';

/** Where a finding sends you. `target` is the thing; `link` is the old category. */
export const ROPA_PATH = 'settings/organisation/compliance/ropa';
export const CENTER_PATH = 'settings/organisation/compliance';

export function linkFor(finding, facts) {
    const target = finding && finding.target;
    if (target && target.id) {
        if (target.kind === 'table') return `studio/datatables/${target.id}`;
        if (target.kind === 'automation') return `studio/automations/${target.id}`;
        if (target.kind === 'app') return `studio/apps/${target.id}`;
    }
    // Findings stored before targets existed, and the register, which is a
    // place rather than a thing.
    const kind = finding && finding.link;
    if (kind === 'register') return ROPA_PATH;
    if (kind === 'org') return CENTER_PATH;
    if (kind === 'app' && facts && facts.app && facts.app.id) return `studio/apps/${facts.app.id}`;
    if (kind === 'table' && facts && facts.table && facts.table.id) return `studio/datatables/${facts.table.id}`;
    return null;
}

/** The word for a target, so a chip reads "Table · Invoices" and not just a name. */
export function targetWords(finding, t) {
    const target = finding && finding.target;
    if (!target || !target.id) return null;
    const kind = target.kind === 'table'
        ? t('playbooks.compliance.kind_table', 'Table')
        : target.kind === 'automation'
            ? t('playbooks.compliance.kind_automation', 'Automation')
            : t('playbooks.compliance.kind_app', 'App');
    return { kind: target.kind, label: kind, name: target.name };
}

/**
 * The severity, in this phase's words.
 *
 * Deliberately not the Compliance Center's "Must fix / Should fix / Consider":
 * this is a build someone just made and is about to share, so the question is
 * what it blocks, not how heavy it is on a score.
 */
export const SEVERITY_WORDS = Object.freeze({
    high: { key: 'playbooks.compliance.sev_high', en: 'Fix before you share' },
    medium: { key: 'playbooks.compliance.sev_medium', en: 'Worth doing' },
    low: { key: 'playbooks.compliance.sev_low', en: 'Good to know' },
});

export function severityWord(severity, t) {
    const entry = SEVERITY_WORDS[severity] || SEVERITY_WORDS.low;
    return t(entry.key, entry.en);
}

export function severityTone(severity) {
    return toneOfSeverity(severity);
}

/**
 * The verdict line.
 *
 * `checks` comes from the server and counts only the RULES — the model's
 * findings are extra, never part of a coverage claim. When it is missing (a
 * review stored before this existed) the card says what it found and claims
 * nothing about what it did not.
 */
export function verdictOf(artifacts, t) {
    const findings = Array.isArray(artifacts && artifacts.findings) ? artifacts.findings : [];
    const checks = (artifacts && artifacts.checks) || null;
    const high = findings.filter((f) => f.severity === 'high').length;
    const clean = checks && Number.isFinite(checks.clean) ? checks.clean : null;
    const ran = checks && Number.isFinite(checks.ran) ? checks.ran : null;
    // NOTHING WAS CHECKED is its own verdict, and it is not a green one.
    //
    // The tone came from the count alone, so an organisation with no framework
    // switched on — or a review whose checks all lacked their preconditions —
    // got "Nothing to tidy up · 0 of 0 checks came back clean" in emerald, with
    // a tick. A false clean bill of health is the one thing this phase must
    // never produce in front of a room that reads regulations for a living.
    const frameworks = Array.isArray(artifacts && artifacts.frameworks) ? artifacts.frameworks : [];
    // `ran` counts the rule predicates whose preconditions were actually there.
    // A real count above zero IS proof something was checked, whatever else is
    // on the artifact; only a zero — or no count at all and no framework —
    // means nothing was.
    const nothingChecked = ran === 0 || (ran === null && frameworks.length === 0);
    return {
        total: findings.length,
        high,
        clean,
        ran,
        nothingChecked,
        tone: nothingChecked ? 'none' : findings.length === 0 ? 'clear' : high > 0 ? 'attention' : 'tidy',
        headline: nothingChecked
            ? t('playbooks.compliance.verdict_none', 'Nothing was checked')
            : findings.length === 0
                ? t('playbooks.compliance.verdict_clean', 'Nothing to tidy up')
                : findings.length === 1
                    ? t('playbooks.compliance.verdict_some_one', '1 thing to tidy up')
                    : t('playbooks.compliance.verdict_some', '{n} things to tidy up', { n: findings.length }),
        cleanLine: !nothingChecked && ran !== null
            ? t('playbooks.compliance.verdict_clean_count', '{clean} of {ran} checks came back clean', { clean, ran })
            : null,
    };
}

/** Where the personal-data judgement came from, in one honest line. */
export function methodLine(facts, t) {
    if (!facts) return null;
    const columns = (facts.table && facts.table.personal) || [];
    if (!columns.length) return null;
    const names = columns.map((c) => c.name).join(', ');
    return facts.personalMethod === 'values'
        ? t('playbooks.compliance.method_values', 'Personal data found by reading the values in {names}', { names })
        : t('playbooks.compliance.method_names', 'Personal data assumed from the column names {names} — the privacy guard was not available to read the values', { names });
}

/** The three groups the list is drawn in. `low` collapses behind a count. */
export function groupFindings(findings) {
    const list = Array.isArray(findings) ? findings : [];
    return {
        high: list.filter((f) => f.severity === 'high'),
        medium: list.filter((f) => f.severity === 'medium'),
        low: list.filter((f) => f.severity !== 'high' && f.severity !== 'medium'),
    };
}

/**
 * Can this finding be fixed from here?
 *
 * The REVIEW decides and stamps `fix_kind` on the finding — it knows what the
 * finding is about, which is the only way one the model wrote ("Missing lawful
 * basis for processing", code `ai_0`) reaches the same fix as the rule that
 * says the same thing. The code list behind it is for findings stored before
 * the stamp existed, and mirrors playbooks/resolvePlan.js.
 */
const RESOLVABLE = [
    (c) => c === 'ropa_retention' || c === 'mirror_personal',
    (c) => c.startsWith('ai_no_guard_'),
    (c) => c.startsWith('aia_disclosure_'),
    (c) => c === 'personal_data_org_wide',
    (c) => c === 'iso_access_roles',
];

export function isResolvable(finding) {
    if (finding && typeof finding === 'object') {
        if (finding.fix_kind) return true;
        const c = String(finding.code || '');
        return RESOLVABLE.some((m) => m(c));
    }
    const c = String(finding || '');
    return RESOLVABLE.some((m) => m(c));
}

// ── the registration, filled in from what is really there ───────────────────

/**
 * Every date a retention period could be counted from, best first.
 *
 * `created_at` and `updated_at` are TIMESTAMPTZ on EVERY datatable and the
 * retention job ages rows by either, so they are always available — a table
 * whose own columns hold only invoice dates and due dates is not a table that
 * cannot have a retention period. "When the row was added" is precisely when
 * the automation extracted it, which is the answer people reach for anyway
 * (owner, 2026-09-17).
 */
export const SYSTEM_DATES = Object.freeze([
    { key: 'created_at', system: true, labelKey: 'playbooks.compliance.date_created', labelEn: 'When the row was added' },
    { key: 'updated_at', system: true, labelKey: 'playbooks.compliance.date_updated', labelEn: 'When the row last changed' },
]);

export function dateColumns(table, t = null) {
    const cols = (table && table.columns) || [];
    const dated = cols.filter((c) => /^(date|datetime|timestamp)$/i.test(String(c.type || '')));
    // A column that says when we RECEIVED it beats one that says when
    // something is due — retention runs from when we got the row.
    const score = (c) => (/(created|added|received|ontvangen|aangemaakt|import)/i.test(`${c.key} ${c.name}`) ? 0
        : /(due|verval|expiry)/i.test(`${c.key} ${c.name}`) ? 2 : 1);
    const own = [...dated].sort((a, b) => score(a) - score(b));
    // A table that declares its OWN `created_at` must not be offered it twice.
    const mine = new Set(own.map((c) => c.key));
    const system = SYSTEM_DATES.filter((d) => !mine.has(d.key))
        .map((d) => ({ ...d, name: t ? t(d.labelKey, d.labelEn) : d.labelEn, type: 'datetime' }));
    // The table's own dates first when it has a good one; the stamp otherwise.
    return own.length && score(own[0]) === 0 ? [...own, ...system] : [...system, ...own];
}

/**
 * Which column names the person a row is about — chosen from the columns the
 * review found personal data in, not from all twenty. The picker still lists
 * every column; it just opens on the right one.
 */
export function subjectColumns(table) {
    const personal = (table && table.personal) || [];
    const rank = (p) => {
        const kinds = p.kinds || [p.kind];
        if (kinds.includes('name')) return 0;
        if (kinds.includes('email')) return 1;
        if (kinds.includes('phone')) return 2;
        return 3;
    };
    return [...personal].sort((a, b) => rank(a) - rank(b));
}

/**
 * Everything the register panel opens with. Nothing here is a guess the person
 * cannot see: each field is either what the table already records, or what the
 * organisation configured, or the best column this table actually has.
 */
export function registrationDefaults(facts) {
    const table = (facts && facts.table) || {};
    const org = (facts && facts.org) || {};
    const dates = dateColumns(table);
    const subjects = subjectColumns(table);
    return {
        // THE LEGAL BASIS IS NEVER PRE-SELECTED. It used to fall back to
        // `org.legalBases[0]`, so the panel opened with a ground already
        // chosen and Register was one click away from putting a legal
        // position on the record that nobody had taken. Art. 6(1)(f) in
        // particular is a balancing test with a documented assessment behind
        // it — not a default. Only the table's own recorded answer fills this.
        lawfulBasis: table.lawfulBasis || '',
        retentionDays: table.retentionDays || org.defaultRetentionDays || '',
        retentionField: table.retentionField || (dates[0] && dates[0].key) || '',
        subjectColumn: table.subjectColumn || (subjects[0] && subjects[0].key) || '',
    };
}

/**
 * Where each pre-filled value came from, so the panel can say so.
 *
 * "Filled in for you" and "already recorded for this table" look identical in
 * a form field and mean very different things on an Art. 30 record. Deriving
 * a value is allowed; letting it be saved without the person knowing it was
 * derived is the half that is not.
 */
export function registrationSources(facts) {
    const table = (facts && facts.table) || {};
    const org = (facts && facts.org) || {};
    const src = (own, derived) => (own ? 'recorded' : (derived ? 'derived' : null));
    return {
        retentionDays: src(table.retentionDays, org.defaultRetentionDays),
        retentionField: src(table.retentionField, dateColumns(table)[0]),
        subjectColumn: src(table.subjectColumn, subjectColumns(table)[0]),
    };
}

/**
 * The six Art. 6 grounds with the organisation's own configured ones first.
 *
 * Ordering is help. Selecting is a position. The shortlist is the whole of
 * what "register in one click" can honestly do for the one field that is a
 * legal judgement rather than a fact about the table.
 */
export function basisOptions(facts, all) {
    const configured = ((facts && facts.org && facts.org.legalBases) || []).filter((b) => all.includes(b));
    return [
        ...configured.map((id) => ({ id, configured: true })),
        ...all.filter((id) => !configured.includes(id)).map((id) => ({ id, configured: false })),
    ];
}

/** What the register wrote, as sentences instead of `processing_register · risks:2`. */
export function writtenWords(registered, t) {
    const written = (registered && registered.written) || [];
    const out = [];
    for (const w of written) {
        if (w === 'processing_register') out.push(t('playbooks.compliance.wrote_ropa', 'the table is in the processing register'));
        else if (w === 'evidence') out.push(t('playbooks.compliance.wrote_evidence', 'this review is on the evidence chain'));
        else if (String(w).startsWith('risks:')) {
            const n = Number(String(w).slice(6)) || 0;
            out.push(n === 1
                ? t('playbooks.compliance.wrote_risks_one', '1 item opened in the risk register')
                : t('playbooks.compliance.wrote_risks', '{n} items opened in the risk register', { n }));
        }
    }
    return out;
}

/** What a retention period means for the rows that exist, in one sentence. */
export function retentionWords(preview, t) {
    if (!preview) return null;
    if (!preview.usable) {
        return {
            tone: 'warning',
            line: t('playbooks.compliance.retention_unusable', '"{field}" holds no readable dates, so nothing would ever be deleted. Pick another column.', { field: preview.retentionFieldName || preview.retentionField }),
        };
    }
    if (preview.outsideWindow > 0) {
        return {
            tone: 'warning',
            line: t('playbooks.compliance.retention_outside', 'The oldest row is {age} days old — {n} of {total} rows fall outside a {days}-day window and would be removed.', {
                age: preview.oldestDays, n: preview.outsideWindow, total: preview.rowCount, days: preview.retentionDays,
            }),
        };
    }
    return {
        tone: 'success',
        line: t('playbooks.compliance.retention_ok', 'The oldest of {total} rows is {age} days old, so nothing falls outside a {days}-day window today.', {
            total: preview.rowCount, age: preview.oldestDays, days: preview.retentionDays,
        }),
    };
}
