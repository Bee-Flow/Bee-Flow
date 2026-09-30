/**
 * The Compliance Center's contract, pinned against the server's own source
 * (read as TEXT — the route files import the database pool). Every route the
 * phone calls, every body key its forms send (they are `.strict()` schemas:
 * a renamed key is a 400) and the response fields the readers rely on. A red
 * line means the server moved: follow it in the registry and the reader, do
 * not loosen the pin.
 */

import fs from 'node:fs';
import path from 'node:path';

import { RECORD_TYPES } from '../model/registry';
import { SETTING_GROUPS } from '../model/settingsFields';
import type { RecordType } from '../model/types';

const SERVER = path.resolve(__dirname, '../../../../../server');
const read = (rel: string) => fs.readFileSync(path.join(SERVER, rel), 'utf8');

function expectAll(src: string, needles: string[]) {
    for (const needle of needles) expect({ needle, found: src.includes(needle) }).toEqual({ needle, found: true });
}

const C = 'routes/compliance/';

describe('the mounts and the gate', () => {
    it('keeps /api/compliance behind the module and the GDPR capability, /api/dsr behind the module', () => {
        expectAll(read('index.js'), [
            "app.use('/api/compliance', requireModule('compliance')",
            "requireCapability('compliance_hub_gdpr')",
            "app.use('/api/dsr', requireModule('compliance'), require('./routes/dsr'))",
        ]);
        expect(read(`${C}checks.js`)).toContain("requirePermission('admin_compliance')");
    });
});

describe('the routes the phone calls', () => {
    const ROUTES: [string, string[]][] = [
        ['counts.js', ["router.get('/counts'", 'attention_open', 'last_run', 'frameworks_summary', 'vulnerabilities_open', 'last_reviewed_at', 'review_due', 'next_sweep_at', "key: 'onboarded'"]],
        ['attention.js', ["router.get('/attention'", 'limit:']],
        ['deadlines.js', ["router.get('/deadlines'"]],
        ['frameworks.js', ["router.get('/frameworks'", "router.post('/frameworks/:id/enable'", "router.post('/frameworks/:id/disable'", "router.post('/frameworks/:id/relevance'", 'name_key: fw.name_key', 'enabled: !!state?.enabled', 'relevance,', 'res.json({ frameworks: list, custom:']],
        ['checks.js', ["router.get('/checks'", "router.get('/checks/:id/history'", "router.post('/checks/run'", "router.post('/checks/:id/run'", "router.post('/checks/:id/auto-fix'", 'titleKey: def.titleKey', 'autoFixId: def.autoFixId', 'scope_id: r?.scope_id', 'framework: z.string(']],
        ['evidence.js', ["router.post('/iso/evidence/upload'", "evidenceUpload.single('file')", 'fileSize: 15 * 1024 * 1024', 'res.json({ uploaded: true, sha256: hash, filename: safeName })', "router.get('/evidence/:checkId'"]],
        ['orgUsers.js', ["router.get('/org-users'", 'displayName:']],
        ['settings.js', ["router.get('/settings'", "router.put('/settings'", 'sanitizeSettingsPatch(body)', "router.post('/settings/onboarded'", "router.post('/settings/scc'", 'const { operator, confirmed } = req.body']],
        ['ropa.js', ["router.get('/ropa'", "router.get('/ropa.pdf'", "router.post('/ropa/review'", 'scc_confirmed: !!e', 'last_reviewed_at: settings.ropa_reviewed_at']],
        ['portability.js', ["router.get('/portability'"]],
        ['accessAudit.js', ["router.get('/access-audit'", "router.get('/access-audit/actions'", "router.get('/access-audit/export'", 'entries,', 'total,', 'res.json({ actions:']],
        ['overview.js', ["router.get('/report.pdf'"]],
        ['isoAuditPack.js', ["router.get('/iso/risks.pdf'", "router.get('/iso/policy-pack.pdf'", "router.get('/iso/evidence-bundle.zip'"]],
        ['isoStatements.js', ["router.get('/iso/soa.pdf'", "router.get('/iso/clause-conformity.pdf'"]],
        ['incidents.js', ["router.get('/incidents'", "router.post('/incidents'", "router.patch('/incidents/:id'", "router.post('/incidents/:id/cra-report'", "router.post('/incidents/:id/customer-notified'", "router.post('/incidents/:id/notify-recipients'", "const STAGES = ['early_warning', 'full']"]],
        ['isoProcess.js', ["router.get('/iso/risks'", "router.post('/iso/risks'", "router.put('/iso/risks/:id'", "router.post('/iso/risks/:id/treatments'", "router.post('/iso/risks/seed'", "router.get('/iso/audit'", "router.post('/iso/audits'", "router.put('/iso/audits/:id'", "router.post('/iso/audits/:id/findings'", "router.post('/iso/reviews'", "router.post('/iso/ncs'", "router.put('/iso/ncs/:id'", "router.post('/iso/objectives'", "router.put('/iso/objectives/:id'", "router.get('/iso/training'", "router.post('/iso/training/:userId/attest'", "router.post('/iso/obligations'", "router.put('/iso/obligations/:id'", "router.post('/iso/obligations/:id/complete'", 'res.json({ risks, treatments, stats })', 'res.json({ audits, findings, reviews, ncs, objectives, mr_inputs: mrInputs })', 'res.json({ personnel, obligations })', 'policy_acks:', 'attested_at:']],
        ['isoSoa.js', ["router.get('/iso/soa'", "router.post('/iso/soa/seed'", "router.put('/iso/soa/:ref'", 'entry: byRef.get(c.ref) || null', 'titleKey: c.titleKey']],
        ['isoDocs.js', ["router.get('/iso/docs'", "router.post('/iso/docs/seed'", "router.get('/iso/docs/:slug'", "router.put('/iso/docs/:slug'", "router.post('/iso/docs/:slug/publish'", 'missing_seeds:']],
        ['isoConnectors.js', ["router.get('/iso/connectors'", "router.get('/iso/connectors/:id/connections'", "router.put('/iso/connectors/:id'", "router.post('/iso/connectors/:id/sweep'", 'titleKey: c.titleKey', 'last_status: cfg.last_status', 'label: r.label']],
        ['customFrameworks.js', ["router.get('/custom/frameworks'", "router.post('/custom/frameworks'", "router.get('/custom/frameworks/:id'", "router.put('/custom/frameworks/:id'", "router.delete('/custom/frameworks/:id'", "router.post('/custom/frameworks/:id/checks'", "router.delete('/custom/checks/:id'", "router.post('/custom/checks/:id/attest'", "router.get('/custom/frameworks/:id/export.json'", 'evidence_refs:']],
        ['machinery.js', ["router.get('/machinery/detections'", "router.post('/machinery/subjects/:id/attest'", "router.get('/machinery/subjects/:id/attestations'", 'manual_subjects: manualSubjects', "const CLASSIFICATIONS = Object.freeze(['safety_component', 'monitoring_only', 'not_safety_component'])"]],
        ['dpia.js', ["router.get('/dpia'", "router.get('/dpia/:agentId/pdf'", "router.post('/dpia/:agentId'", "const MODES = ['attestation', 'questionnaire']", "const RISKS = ['low', 'medium', 'high']"]],
    ];

    it.each(ROUTES)('%s', (file, needles) => expectAll(read(`${C}${file}`), needles));

    it('routes/dsr.js — the admin routes and the masked row', () => {
        expectAll(read('routes/dsr.js'), [
            "router.post('/requests/manual'",
            "router.get('/requests', requireAuth",
            "router.post('/requests/:id/start'",
            "router.post('/requests/:id/extend'",
            "router.post('/requests/:id/verify-identity'",
            "router.get('/requests/:id/timeline'",
            "router.post('/requests/:id/fulfil'",
            "router.get('/requests/:id/export'",
            'res.json({ id: ctx.row.id, timeline: maskTimeline(ctx.row.timeline) })',
            'notify_subject: z.boolean(',
            'received_at: dsrText(',
        ]);
        expectAll(read('compliance/dsr/mask.js'), ['subject_email_masked', "'due_at', 'timeline'", "'identity_status'"]);
    });
});

/** The route file each register's body keys must appear in (as schema keys). */
const SCHEMA_FILE: Record<string, string> = {
    dsr: 'routes/dsr.js',
    incidents: `${C}incidents.js`,
    vulnerabilities: `${C}incidents.js`,
    dpia: `${C}dpia.js`,
    risks: `${C}isoProcess.js`,
    soa: `${C}isoSoa.js`,
    policies: `${C}isoDocs.js`,
    audits: `${C}isoProcess.js`,
    reviews: `${C}isoProcess.js`,
    ncs: `${C}isoProcess.js`,
    objectives: `${C}isoProcess.js`,
    personnel: `${C}isoProcess.js`,
    obligations: `${C}isoProcess.js`,
    connectors: `${C}isoConnectors.js`,
    custom: `${C}customFrameworks.js`,
    machinery: `${C}machinery.js`,
};

function bodyKeys(type: RecordType): string[] {
    const fields = [...(type.create?.fields ?? []), ...(type.edit?.fields ?? []), ...(type.actions ?? []).flatMap((a) => a.fields ?? [])];
    // Two fields are shaped by their builder, not sent as typed (a DPIA's answers, a DSR's received date).
    return [...new Set(fields.map((f) => f.body ?? f.key))].filter((k) => !['purpose', 'data_categories', 'automated_decisions', 'human_oversight'].includes(k));
}

describe('the body keys of every register form', () => {
    it.each(RECORD_TYPES.map((type) => [type.id, type] as const))('%s sends only keys its schema declares', (id, type) => {
        const src = read(SCHEMA_FILE[id] as string);
        for (const key of bodyKeys(type)) expect({ id, key, declared: new RegExp(`\\b${key}:`).test(src) }).toEqual({ id, key, declared: true });
    });

    it('the settings form writes only whitelisted columns', () => {
        const store = read('stores/complianceStore.js');
        for (const field of SETTING_GROUPS.flatMap((g) => g.fields).filter((f) => f.kind !== 'relevance')) {
            expect({ column: field.name, whitelisted: store.includes(field.name) }).toEqual({ column: field.name, whitelisted: true });
        }
    });
});
