/**
 * Does every lesson's gate cover every surface that lesson actually uses?
 *
 * The gate is what the Learning Center filters on, so it is a promise to the
 * learner: see this lesson, and you can do it. An under-gated lesson breaks the
 * promise twice — the learner meets a lock or an upgrade prompt halfway
 * through, and a verified-action step they can never satisfy blocks the course
 * badge behind it permanently.
 *
 * So the gates are checked against the PRODUCT, not against themselves:
 * surfaceGates.js records what Bee Flow's own code demands of each screen and
 * route (Studio rail gates, server mounts, org sub-tab filter, role table), and
 * this unions the gates of the surfaces each lesson's own steps walk into.
 *
 * Runs over the SHIPPED catalog (LESSONS + ACTION_CHECKS), not the authoring
 * JSON in .claude/handoff/curriculum — that directory is untracked, so a test
 * reading it would be green on a clean checkout while the shipped gates rotted.
 */
import { describe, expect, it } from 'vitest';

import { ACTION_CHECKS } from './actionChecks';
import { LESSONS, lessonVisible } from './lessons';
import { NAV_SURFACE_GATES, PERMISSION_IMPLIES, endpointGate } from './surfaceGates';

const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

const expandPerms = (perms) => {
    const out = new Set(perms);
    for (const p of perms) for (const q of PERMISSION_IMPLIES[p] || []) out.add(q);
    return out;
};

/** The surfaces a lesson walks into, split by whether it only looks or acts. */
function surfacesOf(lesson) {
    const visit = new Set(), act = new Set(), endpoints = new Set();
    for (const step of lesson.steps || []) {
        const isAction = step.type === 'action' || !!step.checkId;
        for (const nav of [step.navigateTo, step.launch?.navigateTo].filter(Boolean)) {
            (isAction ? act : visit).add(nav);
        }
        for (const crit of ACTION_CHECKS[step.checkId]?.criteria || []) {
            if (crit.endpoint) endpoints.add(crit.endpoint);
        }
        if (ACTION_CHECKS[step.checkId]?.endpoint) endpoints.add(ACTION_CHECKS[step.checkId].endpoint);
    }
    return { visit, act, endpoints };
}

/** The gate those surfaces add up to, plus where each requirement came from. */
function requiredGate(lesson) {
    const { visit, act, endpoints } = surfacesOf(lesson);
    const feat = new Set(), perm = new Set(), why = {}, unknown = [];
    const take = (gate, permKey, source) => {
        if (!gate) return false;
        for (const f of gate.feat) { feat.add(f); why[f] ??= source; }
        for (const p of gate[permKey]) { perm.add(p); why[p] ??= source; }
        return true;
    };
    for (const n of visit) if (!take(NAV_SURFACE_GATES[n], 'permView', n)) unknown.push(`navigateTo '${n}'`);
    for (const n of act) if (!take(NAV_SURFACE_GATES[n], 'permWrite', n)) unknown.push(`navigateTo '${n}'`);
    for (const e of endpoints) if (!take(endpointGate(e), 'permWrite', e)) unknown.push(`endpoint '${e}'`);
    return { feat: [...feat], perm: [...perm], why, unknown };
}

describe('lesson gates cover the surfaces their lessons use', () => {
    const rows = LESSONS.map((lesson) => {
        const need = requiredGate(lesson);
        const heldFeat = new Set(asList(lesson.gate?.feature));
        // ANY-of and ALL-of permissions both count as held; only the ALL-of form
        // can honestly satisfy "you need BOTH of these powers", but a lesson
        // that names one of them in `permission` still holds it.
        const heldPerm = expandPerms([...asList(lesson.gate?.permission), ...asList(lesson.gate?.permissionsAll)]);
        return {
            id: lesson.id,
            missingFeature: need.feat.filter((f) => !heldFeat.has(f)),
            missingPermission: need.perm.filter((p) => !heldPerm.has(p)),
            unknown: need.unknown,
            why: need.why,
        };
    });

    it('names every surface the catalog uses in surfaceGates.js', () => {
        const orphans = rows.filter((r) => r.unknown.length)
            .map((r) => `${r.id}: ${r.unknown.join(', ')}`);
        expect(orphans, 'add these to NAV_SURFACE_GATES / ENDPOINT_SURFACE_GATES with the gate the product puts on them').toEqual([]);
    });

    it('gates every lesson for every capability it makes the learner use', () => {
        const under = rows.filter((r) => r.missingFeature.length)
            .map((r) => `${r.id} needs feature ${r.missingFeature.map((f) => `${f} (from ${r.why[f]})`).join(' + ')}`);
        expect(under, 'these lessons are shown to orgs whose plan cannot open the screens they teach').toEqual([]);
    });

    it('gates every lesson for every permission it makes the learner exercise', () => {
        const under = rows.filter((r) => r.missingPermission.length)
            .map((r) => `${r.id} needs permission ${r.missingPermission.map((p) => `${p} (from ${r.why[p]})`).join(' + ')}`);
        expect(under, 'these lessons are shown to roles that cannot perform the actions they ask for').toEqual([]);
    });
});

describe('gate semantics', () => {
    const lesson = (gate) => ({ id: 'x', gate, steps: [] });
    const user = (permissions) => ({ permissions });
    const has = (...ids) => (f) => ids.includes(f);

    it('treats a permission LIST as ANY-of — several roles open the same screen', () => {
        const l = lesson({ permission: ['org_admin', 'manage_users'] });
        expect(lessonVisible(l, user(['manage_users']))).toBe(true);
        expect(lessonVisible(l, user(['org_admin']))).toBe(true);
        expect(lessonVisible(l, user(['manage_agents']))).toBe(false);
    });

    it('treats permissionsAll as ALL-of — two separate powers, not either', () => {
        const l = lesson({ permissionsAll: ['manage_skills', 'manage_agents'] });
        expect(lessonVisible(l, user(['manage_skills']))).toBe(false);
        expect(lessonVisible(l, user(['manage_agents']))).toBe(false);
        expect(lessonVisible(l, user(['manage_skills', 'manage_agents']))).toBe(true);
        expect(lessonVisible(l, user(['all'])), "the 'all' wildcard still wins").toBe(true);
    });

    it('treats a feature LIST as ALL-of — half a plan is not the plan', () => {
        const l = lesson({ feature: ['automations', 'app_studio'] });
        expect(lessonVisible(l, user([]), has('app_studio'))).toBe(false);
        expect(lessonVisible(l, user([]), has('automations'))).toBe(false);
        expect(lessonVisible(l, user([]), has('automations', 'app_studio'))).toBe(true);
    });

    it('still treats feature gates as visible with no licence provider', () => {
        // Engine context (the tour runner) has no licence context; the Learning
        // Center page is the authoritative filter and always passes hasFeature.
        expect(lessonVisible(lesson({ feature: ['automations'] }), user([]), undefined)).toBe(true);
    });
});
