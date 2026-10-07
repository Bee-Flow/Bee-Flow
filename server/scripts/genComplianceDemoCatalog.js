/**
 * Generate the compliance demo's CATALOG fixture from the product's own
 * catalogs, rather than hand-copying 44 check ids and 93 control refs.
 *
 * The public demo renders the real ComplianceHub against fixtures. Every list
 * it shows is keyed by an identifier the component turns into an i18n lookup
 * (`titleKey`) or a cross-reference (a control's `checks: [...]` must name
 * check ids that exist, or the SoA's "how is this verified" column comes up
 * empty). Typing those out by hand means the demo drifts the moment someone
 * adds a check — silently, because a missing key renders as a blank cell, not
 * as an error.
 *
 * So the catalog half of the fixture is generated. The *organisation* half —
 * which checks pass, whose DSR is open, what the risk register says — is
 * hand-written in fixtures/compliance.js, because that is editorial content
 * about a fictional company and has no source to derive it from.
 *
 * Run: cd server && node scripts/genComplianceDemoCatalog.js
 */

const fs = require('fs');
const path = require('path');

// Registers every check definition — and exports CHECK_DIRS, the directory
// list the loader walked, so the generator reports the same coverage the
// registry contract test asserts instead of a second hand-kept list.
const checksIndex = require('../compliance/checks');
const registry = require('../compliance/registry');
const frameworks = require('../compliance/frameworks');
const isoControls = require('../compliance/iso/controls');
const connectors = require('../compliance/connectors');

const OUT = path.resolve(
    __dirname, '..', '..', 'agent-hub', 'src', 'demo', 'fixtures', 'complianceCatalog.js',
);

function main() {
    const checks = registry.getAll().map(d => ({
        check_id: d.id,
        regulation: d.regulation,
        // The framework this check BELONGS to (its home), and every framework
        // it COUNTS for. The demo's framework pages filter on `frameworks[]`
        // exactly as routes/compliance/checks.js does, so a check tagged into
        // a second regulation shows up on both pages there too.
        framework_id: frameworks.frameworkIdOf(d.regulation),
        frameworks: (d.frameworks || []).map(f => ({
            regulation: f.regulation,
            ref: f.ref,
            framework_id: f.framework_id,
            in_force_since: f.in_force_since || null,
        })),
        // When this check's own article started to apply — the demo renders it
        // as the "in force since" line and as the not-yet-in-force tint.
        in_force_since: d.in_force_since || null,
        article: d.article,
        severity: d.severity,
        scope: d.scope,
        verification: d.verification || 'automated',
        titleKey: d.titleKey,
        descriptionKey: d.descriptionKey,
        remediationKey: d.remediationKey,
        remediationLink: d.remediationLink || null,
        autoFixId: d.autoFixId || null,
    }));

    // The framework catalogue, as /api/compliance/frameworks serves the static
    // half of it. The per-org half (enabled, locked, relevance, score) is
    // editorial and stays in fixtures/compliance.js.
    const checksPerRegulation = {};
    for (const d of registry.getAll()) {
        for (const f of d.frameworks || []) {
            checksPerRegulation[f.regulation] = (checksPerRegulation[f.regulation] || 0) + 1;
        }
    }
    const fws = frameworks.listBuiltin().map(f => ({
        id: f.id,
        regulation: f.regulation,
        regulation_code: f.regulation_code,
        name_key: f.name_key,
        description_key: f.description_key,
        affects_key: f.affects_key,
        core: !!f.core,
        capability: f.capability || null,
        checks_dir: f.checks_dir,
        checks_count: checksPerRegulation[f.regulation] || 0,
        in_force_since: f.in_force_since || null,
        in_force_from: f.in_force_from || null,
        phases: (f.phases || []).map(p => ({ date: p.date, label_key: p.label_key })),
        registers: f.registers || [],
        relevance_gate: !!f.relevance_gate,
        sources: (f.sources || []).map(src => ({ label: src.label, url: src.url })),
        legal_status_verified: f.legal_status_verified || null,
    }));

    const milestones = frameworks.MILESTONES.map(m => ({
        id: m.id,
        date: m.date,
        expected: m.expected || null,
        framework_id: m.framework_id,
        kind: m.kind,
        affects_kind: m.affects_kind || null,
        label_key: m.label_key,
        detail_key: m.detail_key,
    }));

    const controls = isoControls.CONTROLS.map(c => ({
        ref: c.ref,
        key: c.key,
        theme: c.theme,
        bucket: c.bucket,
        titleKey: c.titleKey,
        objectiveKey: c.objectiveKey,
    }));

    const conns = (typeof connectors.getAll === 'function' ? connectors.getAll() : connectors.CONNECTORS)
        .map(c => ({
            id: c.id,
            titleKey: c.titleKey,
            descKey: c.descKey,
            covered_controls: c.coveredControls || [],
            checks: c.checks || [],
            credential: c.credential || null,
            settings_hint: c.settingsHint || null,
        }));

    const body = `/**
 * GENERATED — do not edit by hand.
 *   cd server && node scripts/genComplianceDemoCatalog.js
 *
 * The framework catalogue, its regulatory milestones, the check registry, the
 * ISO 27001 Annex A catalog and the evidence-connector
 * catalog, as the compliance demo needs them. Generated from the server's own
 * definitions so the demo cannot drift from the product: every check id here
 * exists, every titleKey resolves against the bundled EN defaults, and every
 * control's \`checks\` cross-reference names a real check.
 *
 * Regenerate after adding a check, a control or a connector.
 */

export const FRAMEWORKS = ${JSON.stringify(fws, null, 4)};

export const MILESTONES = ${JSON.stringify(milestones, null, 4)};

export const CHECK_DEFS = ${JSON.stringify(checks, null, 4)};

export const ISO_CONTROLS = ${JSON.stringify(controls, null, 4)};

export const ISO_THEMES = ${JSON.stringify(isoControls.THEMES, null, 4)};

export const ISO_CONNECTORS = ${JSON.stringify(conns, null, 4)};
`;

    fs.writeFileSync(OUT, body, 'utf8');
    console.log(`[gen] ${path.relative(process.cwd(), OUT)}`);
    const dirs = typeof checksIndex.loadedDirs === 'function' ? checksIndex.loadedDirs() : [];
    console.log(`[gen] ${fws.length} frameworks, ${milestones.length} milestones, ${checks.length} checks `
        + `from ${dirs.length}/${(checksIndex.CHECK_DIRS || []).length} framework dirs, `
        + `${controls.length} controls, ${conns.length} connectors`);
    const missing = (checksIndex.CHECK_DIRS || []).filter(d => !dirs.includes(d));
    if (missing.length) console.warn(`[gen] no check directory on disk for: ${missing.join(', ')}`);
}

main();
