#!/usr/bin/env node
/**
 * Does every lesson's gate cover every surface the lesson actually uses?
 *
 * A lesson's gate is a PROMISE: "if you can see this, you can do it". The
 * Learning Center filters on it (lessonVisible / gatePasses), so an
 * under-gated lesson is shown to someone whose plan or role cannot open the
 * screen it walks them into — the learner hits a lock, or an upgrade prompt,
 * halfway through, and a verified-action step they can never satisfy blocks
 * the course badge behind it forever.
 *
 * So the gate is checked against the product rather than against itself:
 * surfaceGates.json records the gate BEE FLOW's own code puts on each screen
 * and endpoint (Studio rail gates, route mounts, org sub-tab filter, role
 * table), and this script unions the gates of the surfaces each lesson
 * touches.
 *
 * Two distinctions matter, and both were false positives before they existed:
 *   • VISIT vs ACT. A tour step only opens a screen; Studio sections are open
 *     to everyone and the permission only bites on create/change. So a tour
 *     contributes permView, an action step contributes permWrite.
 *   • Permission implication. manage_datatables is strictly stronger than
 *     use_datatables; a gate that already demands the stronger one is not
 *     missing the weaker one.
 *
 * The table itself lives in agent-hub/src/components/onboarding/surfaceGates.js
 * (tracked), and lessonGates.test.js runs this same audit over the shipped
 * catalog — so a gate cannot rot without a red test.
 *
 * Run: node gateAudit.mjs [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ONE copy of the product's surface gates, in the tracked frontend source.
// agent-hub/src/components/onboarding/lessonGates.test.js runs this same audit
// over the SHIPPED catalog on every frontend test run; this script is the fast
// authoring-time version, run before generate.mjs.
import {
    NAV_SURFACE_GATES, ENDPOINT_SURFACE_GATES, PERMISSION_IMPLIES, endpointGate,
} from '../../../agent-hub/src/components/onboarding/surfaceGates.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SG = { nav: NAV_SURFACE_GATES, endpoint: ENDPOINT_SURFACE_GATES };
const IMPLIES = PERMISSION_IMPLIES;
const expand = (perms) => {
    const out = new Set(perms);
    for (const p of perms) for (const q of IMPLIES[p] || []) out.add(q);
    return out;
};

const epGate = endpointGate;

// navigateTo on a tour step = visit; launch.navigateTo on an action step = act.
function surfacesOf(doc) {
    const visit = new Set(), act = new Set(), eps = new Set();
    for (const s of doc.steps || []) {
        if (s.navigateTo) (s.type === 'action' ? act : visit).add(s.navigateTo);
        if (s.launch?.navigateTo) (s.type === 'action' ? act : visit).add(s.launch.navigateTo);
    }
    const walk = (o) => {
        if (Array.isArray(o)) return o.forEach(walk);
        if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) {
            if ((k === 'endpoint' || k === 'path') && typeof v === 'string' && v.startsWith('/')) eps.add(v);
            else walk(v);
        }
    };
    walk(doc.actionChecks || []);
    return { visit, act, eps };
}

export function requiredGate(doc) {
    const { visit, act, eps } = surfacesOf(doc);
    const feat = new Set(), perm = new Set(), why = {};
    const take = (g, permKey, src) => {
        if (!g) return null;
        for (const f of g.feat) { feat.add(f); why[f] ??= src; }
        for (const p of g[permKey] || []) { perm.add(p); why[p] ??= src; }
        return g;
    };
    const unknown = [];
    for (const n of visit) if (!take(SG.nav[n], 'permView', n)) unknown.push(`nav:${n}`);
    for (const n of act) if (!take(SG.nav[n], 'permWrite', n)) unknown.push(`nav:${n}`);
    for (const e of eps) if (!take(epGate(e), 'permWrite', e)) unknown.push(`endpoint:${e}`);
    return { feat: [...feat].sort(), perm: [...perm].sort(), why, unknown };
}

const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

export function auditLesson(doc) {
    const need = requiredGate(doc);
    const hasFeat = new Set(asList(doc.gate?.feature));
    // permission is ANY-of, permissionsAll is ALL-of; only the latter can
    // honestly satisfy "you need BOTH of these powers".
    const hasPerm = expand([...asList(doc.gate?.permission), ...asList(doc.gate?.permissionsAll)]);
    return {
        id: doc.id,
        missingFeature: need.feat.filter((f) => !hasFeat.has(f)),
        missingPermission: need.perm.filter((p) => !hasPerm.has(p)),
        unknown: need.unknown,
        why: need.why,
    };
}

const files = fs.readdirSync(path.join(DIR, 'lessons')).filter((f) => f.endsWith('.json')).sort();
const results = files.map((f) => auditLesson(JSON.parse(fs.readFileSync(path.join(DIR, 'lessons', f), 'utf8'))));
const bad = results.filter((r) => r.missingFeature.length || r.missingPermission.length || r.unknown.length);

if (process.argv.includes('--json')) {
    console.log(JSON.stringify(bad, null, 1));
} else {
    for (const r of bad) {
        const bits = [];
        if (r.missingFeature.length) bits.push(`feature +[${r.missingFeature}]`);
        if (r.missingPermission.length) bits.push(`permission +[${r.missingPermission}]`);
        if (r.unknown.length) bits.push(`UNKNOWN SURFACE ${r.unknown}`);
        const src = [...r.missingFeature, ...r.missingPermission].map((k) => `${k}←${r.why[k]}`).join(' ');
        console.log(`${r.id.padEnd(36)} ${bits.join('  ')}\n${' '.repeat(37)}${src}`);
    }
    console.log(`\n${bad.length} of ${results.length} lessons under-gated.`);
}
process.exit(bad.length ? 1 : 0);
