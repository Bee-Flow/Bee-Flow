/**
 * Clean up what the playbook test runs left behind — the harness's AND the
 * person's own: playbooks, the automations and apps they built, the tables they
 * created, and the test forms (automations with a form trigger) with their
 * "Answers — …" tables.
 *
 * DRY RUN BY DEFAULT: it prints what it WOULD delete and stops. `--apply`
 * deletes. Runs inside the server container as the same org user the runs
 * used (connector JWT, like the drivers), through the public DELETE routes —
 * so it can only remove what that user owns, and every removal is the same
 * one the UI's trash button performs.
 *
 * What is selected:
 *   1. every playbook of the user, plus its artifacts: the automation it built,
 *      the app it built, and the table it CREATED (options.tableMode === 'new';
 *      an existing table it linked is never touched);
 *   2. by name (the runs' own titles and the cases' "PB " prefix): automations,
 *      apps and own tables matching --match (a regex), default
 *      ^(PB |Facturen|Factuur|Invoice|Leveranciers|Contracten|Extraction|Untitled|Naamloze)
 *   3. with --forms: automations whose trigger is a form, plus tables named
 *      "Answers — …".
 * Never selected: Nextcloud/spreadsheet mirrors (managedKind set), anything
 * in --keep, anything owned by someone else.
 *
 * Usage, inside the container (scripts/cleanup-test-runs.sh does the copy):
 *   node /tmp/cleanup-test-runs.js [--apply] [--forms] [--match <regex>] [--keep id,id] [--only playbooks,apps,automations,datatables]
 */

const http = require('http');

const APP = process.env.BEEFLOW_APP_DIR || '/app';
const ORG = process.env.HARNESS_ORG || 'nc-nextcloud-nc-host-bee';
const NC_UID = process.env.HARNESS_NC_UID || 'admin';
const EMAIL = process.env.HARNESS_EMAIL || 'admin@example.com';
const PORT = Number(process.env.PORT || 3001);

function arg(name, dflt) { const i = process.argv.indexOf(`--${name}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt; }
function flag(name) { return process.argv.includes(`--${name}`); }

const DEFAULT_MATCH = '^(PB |Facturen|Factuur|Invoice|Leveranciers|Contracten|Extraction|Untitled|Naamloze)';

function request(method, path, body, headers) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: PORT, path, method, headers: { ...headers, Accept: 'application/json' } }, (res) => {
            let b = ''; res.on('data', (c) => { b += c; });
            res.on('end', () => { let json = null; try { json = b ? JSON.parse(b) : null; } catch { json = { raw: b.slice(0, 300) }; } resolve({ status: res.statusCode, body: json }); });
            res.on('error', reject);
        });
        req.on('error', reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
    });
}

function pickList(body, ...keys) {
    if (Array.isArray(body)) return body;
    for (const k of keys) if (body && Array.isArray(body[k])) return body[k];
    return [];
}

async function main() {
    const apply = flag('apply');
    const forms = flag('forms');
    const match = new RegExp(arg('match', DEFAULT_MATCH), 'i');
    const keep = new Set(String(arg('keep', '')).split(',').map((s) => s.trim()).filter(Boolean));
    const only = new Set(String(arg('only', 'playbooks,apps,automations,datatables')).split(',').map((s) => s.trim()).filter(Boolean));

    const jwt = require(APP + '/node_modules/jsonwebtoken');
    const key = await require(APP + '/stores/configStore').getSecret(`connector_tenant_key_${ORG}`);
    if (!key) { console.error(`no tenant key for org ${ORG}`); return 2; }
    const token = jwt.sign({ sub: NC_UID, email: EMAIL, name: NC_UID, nc_admin: true }, key, { algorithm: 'HS256', issuer: 'nextcloud-connector', audience: 'beeflow.nl', expiresIn: 3600 });
    const h = { Authorization: `Bearer ${token}`, 'X-Beeflow-Source': 'nextcloud-connector', 'X-Beeflow-NC-Uid': NC_UID, 'Content-Type': 'application/json' };
    const api = (m, p, b) => request(m, p, b, h);

    // ── inventory ──────────────────────────────────────────────────────────
    const [pbs, apps, autos, tables] = await Promise.all([
        api('GET', '/api/playbooks'), api('GET', '/api/studio-apps/mine'), api('GET', '/api/automation'), api('GET', '/api/datatables'),
    ]);
    for (const [name, r] of [['playbooks', pbs], ['apps', apps], ['automations', autos], ['datatables', tables]]) {
        if (r.status !== 200) { console.error(`${name}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`); return 2; }
    }
    const playbooks = pickList(pbs.body, 'playbooks');
    const appList = pickList(apps.body, 'apps', 'items');
    const autoList = pickList(autos.body, 'automations');
    const tableList = pickList(tables.body, 'datatables');

    const sel = { playbooks: new Map(), apps: new Map(), automations: new Map(), datatables: new Map() };
    const add = (kind, id, label, why) => { if (!id || keep.has(id) || !only.has(kind)) return; if (!sel[kind].has(id)) sel[kind].set(id, { id, label, why }); };

    // 1. playbooks and their artifacts (the full entity carries the phases)
    for (const row of playbooks) {
        const full = await api('GET', `/api/playbooks/${encodeURIComponent(row.id)}`);
        const pb = full.status === 200 && full.body && full.body.playbook ? full.body.playbook : row;
        add('playbooks', pb.id, pb.title, 'a playbook');
        const createdTable = pb.options && pb.options.tableMode === 'new';
        for (const p of pb.phases || []) {
            const a = p.artifacts || {};
            const kind = p.kind || p.key;
            if (kind === 'automation' && a.automationId) add('automations', a.automationId, a.automationTitle || a.automationId, `built by playbook "${pb.title}"`);
            if ((kind === 'app' || kind === 'app_turn') && a.appId) add('apps', a.appId, a.appName || a.appId, `built by playbook "${pb.title}"`);
            if (kind === 'table' && a.datatableId && createdTable) add('datatables', a.datatableId, a.datatableName || a.datatableId, `created by playbook "${pb.title}"`);
        }
    }
    // 2. by name
    for (const a of autoList) {
        const title = a.title || a.name || '';
        const trig = (a.definition && a.definition.trigger && a.definition.trigger.kind) || a.triggerType || '';
        if (match.test(title)) add('automations', a.id, title, `title matches ${match}`);
        else if (forms && String(trig) === 'form') add('automations', a.id, title, 'a form (form trigger)');
    }
    for (const a of appList) { const name = a.name || ''; if (match.test(name)) add('apps', a.id, name, `name matches ${match}`); }
    // Managed kinds: a form's answers table is the form's own and goes with
    // it (--forms); every other managed kind mirrors something that lives
    // elsewhere (a Nextcloud table, a spreadsheet) and is never touched.
    const isMirror = (t) => !!t.managedKind && t.managedKind !== 'form_answers';
    for (const t of tableList) {
        const name = t.name || '';
        if (isMirror(t)) continue;
        if (t.managedKind === 'form_answers') { if (forms) add('datatables', t.id, `${name} (${t.key}, ${t.rowCount ?? '?'} rows)`, 'a form\'s answers table'); continue; }
        if (match.test(name)) add('datatables', t.id, `${name} (${t.key}, ${t.rowCount ?? '?'} rows)`, `name matches ${match}`);
    }
    const skippedMirrors = tableList.filter((t) => isMirror(t) && match.test(t.name || ''));

    // ── report ─────────────────────────────────────────────────────────────
    const total = Object.values(sel).reduce((n, m) => n + m.size, 0);
    console.log(`\n${apply ? 'DELETING' : 'DRY RUN — would delete'} ${total} item(s) as ${NC_UID}@${ORG}:`);
    for (const kind of ['playbooks', 'apps', 'automations', 'datatables']) {
        if (!sel[kind].size) continue;
        console.log(`\n  ${kind} (${sel[kind].size})`);
        for (const it of sel[kind].values()) console.log(`    - ${it.id}  ${it.label}  — ${it.why}`);
    }
    if (skippedMirrors.length) console.log(`\n  kept (mirrors are never deleted): ${skippedMirrors.map((t) => `${t.name} (${t.id}, ${t.managedKind})`).join('; ')}`);
    if (keep.size) console.log(`  kept (--keep): ${[...keep].join(', ')}`);
    if (!apply) { console.log('\nNothing deleted. Re-run with --apply to delete exactly this list (add --keep id,id to protect items).'); return 0; }

    // ── delete: playbooks → apps → automations → datatables ────────────────
    let failed = 0;
    const del = async (kind, path, it) => {
        const r = await api('DELETE', path);
        const ok = r.status === 200 || r.status === 204;
        if (!ok) failed += 1;
        console.log(`  ${ok ? 'deleted' : `FAILED ${r.status}`} ${kind} ${it.id} ${it.label}${ok ? '' : ` — ${JSON.stringify(r.body).slice(0, 160)}`}`);
    };
    for (const it of sel.playbooks.values()) await del('playbook', `/api/playbooks/${encodeURIComponent(it.id)}`, it);
    for (const it of sel.apps.values()) await del('app', `/api/studio-apps/${encodeURIComponent(it.id)}`, it);
    for (const it of sel.automations.values()) await del('automation', `/api/automation/${encodeURIComponent(it.id)}`, it);
    for (const it of sel.datatables.values()) await del('datatable', `/api/datatables/${encodeURIComponent(it.id)}`, it);
    console.log(`\n${total - failed} deleted, ${failed} failed.`);
    return failed ? 1 : 0;
}

main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(2); });
