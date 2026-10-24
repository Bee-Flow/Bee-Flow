import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import { STUDIO_APPS } from './studioApps';
import {
    canSeeStudio, isStudioBuilder, studioAppForKind, studioEntrySections, studioGateContext,
    studioLanding, studioNavSections, studioSectionAccess, studioSectionLabel,
} from './studioNav';
import { STUDIO_START } from './studioStart';

/**
 * The two steps between the register and the rows someone sees, plus the two
 * lookups that are otherwise rewritten per screen.
 *
 * What is pinned here is precisely what was NOT covered elsewhere: the
 * runtime-module branch of `studioSectionLabel` — the branch that is the whole
 * reason for that helper, because a rail that shows the translated name next to a
 * card that shows the raw key is the drift this file must prevent.
 */
describe('studioSectionLabel', () => {
    const t = (key, fallback) => fallback || `t:${key}`;

    it('een RUNTIME-MODULE draagt een locale-bewuste label(t, locale) — die wint', () => {
        const seen = [];
        const app = { id: 'security', label: (tt, locale) => { seen.push(locale); return `Security(${locale})`; } };
        expect(studioSectionLabel(app, t, 'nl')).toBe('Security(nl)');
        expect(seen).toEqual(['nl']);
    });

    it('een ingebouwde sectie gebruikt sleutel + Engelse terugval', () => {
        expect(studioSectionLabel({ labelKey: 'studio.tab.agents', labelFallback: 'Agents' }, t, 'en')).toBe('Agents');
        // Without a fallback, still ask for the key — do not show the key.
        expect(studioSectionLabel({ labelKey: 'studio.tab.x' }, t, 'en')).toBe('t:studio.tab.x');
    });

    it('valt nooit stil om: geen sectie, geen sleutel', () => {
        expect(studioSectionLabel(null, t, 'en')).toBe('');
        expect(studioSectionLabel({ id: 'x' }, t, 'en')).toBe('x');
        expect(studioSectionLabel({ id: 'x', labelFallback: 'X' }, t, 'en')).toBe('X');
    });
});

/**
 * And the copy guard: ONE answer to "what is this section called", in the whole tree.
 *
 * The helper once stood four times separately in the tree. Two of those copies
 * (the Studio flyout in Sidebar.jsx and the rail in StudioRail.jsx) both missed
 * the same two safety nets of the shared version: no `!app` branch, and no
 * `!app.labelKey` branch — a descriptor without a key there called `t(undefined)`
 * instead of falling back to `labelFallback || app.id`. That is exactly the case
 * an installed remote module hits, and then the rail draws a nameless row next to
 * a card that does know the name.
 *
 * Two assertions, because a third copy comes in two ways. Under the same name —
 * that catches the first. Under its own name (`labelOf`, as the rail called it) —
 * that catches the second, by searching for the SHAPE instead of the word: the
 * runtime-module branch (`typeof x.label === 'function'`) together with a
 * `labelKey` branch in the same file. That combination IS the copy, and it leaves
 * `t(category.labelKey, …)` in the rail alone — a category heading is not a
 * section descriptor.
 */
describe('studioSectionLabel — geen tweede kopie in de boom', () => {
    const HERE = path.dirname(fileURLToPath(import.meta.url));
    const SRC_DIR = path.resolve(HERE, '../../..');
    const OWNER = 'components/admin/Studio/studioNav.ts';

    // Production source only: a stub in a test file is not a second path that a
    // user ever sees.
    function sourceFiles(dir) {
        const out = [];
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { out.push(...sourceFiles(full)); continue; }
            if (!/\.[jt]sx?$/.test(entry.name) || /\.test\.[jt]sx?$/.test(entry.name)) continue;
            out.push(full);
        }
        return out;
    }
    const rel = (f) => path.relative(SRC_DIR, f).split(path.sep).join('/');
    const FILES = sourceFiles(SRC_DIR).map((f) => [rel(f), fs.readFileSync(f, 'utf8')]);

    it('de boom is echt gescand, en studioNav.ts zit erin', () => {
        expect(FILES.length).toBeGreaterThan(100);
        expect(FILES.map(([f]) => f)).toContain(OWNER);
    });

    it('precies één bestand DEFINIEERT studioSectionLabel', () => {
        const declares = /(?:function|const|let|var)\s+studioSectionLabel\b/;
        const owners = FILES.filter(([, src]) => declares.test(src)).map(([f]) => f);
        expect(owners, 'importeer studioSectionLabel uit studioNav.ts in plaats van hem opnieuw te schrijven').toEqual([OWNER]);
    });

    /**
     * Comments do not count. The previous version ran `\blabelKey\b` over the WHOLE
     * file, so one harmless comment line next to a `typeof x.label === 'function'`
     * that stands there for another reason (recent/recentWork.js recognises a
     * runtime module with it) turned the guard red. Proven: adding that one line
     * gave 1 failed | 9 passed. A guard that turns red wrongly gets thrown away.
     */
    function stripComments(src) {
        return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    }

    /**
     * Search for the CHOICE, not for one spelling of it.
     *
     * The old shape-searcher hung on `typeof x.label === 'function'` and let the
     * at least as natural `app.label ? app.label(t, locale) : …` pass unseen —
     * proven: a live third copy in StudioRail.jsx in that shape gave 10 passed. A
     * copy must CALL `label()` (that is the runtime branch) and use `labelKey` (that
     * is the other), so that is what is searched for — and within ONE window, not
     * file-wide.
     */
    // NB: no `app.label ?` detector. That shape stands all over the tree for entirely
    // different reasons (`row.label ?? row.name` in a <select>), and a guard that
    // turns red THERE is no longer a guard. What a copy inevitably does is CALL `label`
    // as a FUNCTION — that is the branch it takes over from studioSectionLabel — so
    // that is the anchor.
    const CHOOSES = [
        /\.label\s*\(/g,                                  // app.label(t, locale), also in a ternary
        /typeof\s+[A-Za-z_$][\w$]*\.label\s*===\s*'function'/g,
    ];
    const WINDOW = 300;

    function computesLabel(src) {
        const clean = stripComments(src);
        if (!/\blabelKey\b/.test(clean)) return false;
        for (const re of CHOOSES) {
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(clean)) !== null) {
                const near = clean.slice(Math.max(0, m.index - WINDOW), m.index + WINDOW);
                if (/\blabelKey\b/.test(near)) return true;
            }
        }
        return false;
    }

    it('en precies één bestand rekent de sectienaam zelf uit — ook onder een andere naam', () => {
        const copies = FILES
            .filter(([f]) => f !== OWNER)
            .filter(([, src]) => computesLabel(src))
            .map(([f]) => f);
        expect(copies, 'dit bestand kiest zelf tussen label() en labelKey — dat is studioSectionLabel, gebruik de gedeelde').toEqual([]);
    });

    it('de vormzoeker ziet de korte schrijfwijze ook, en beschuldigt geen commentaar', () => {
        // Twee kopieën die de oude zoeker allebei miste of ten onrechte ving.
        expect(computesLabel(
            "const railName = (app) => (app.label ? app.label(t, locale) : t(app.labelKey, app.labelFallback));",
        ), 'de ternary-vorm is óók een kopie').toBe(true);
        expect(computesLabel(
            "if (typeof app.label === 'function') unsupported.push(app.id);\n// een sectie herken je aan haar labelKey",
        ), 'commentaar is geen tweede tak').toBe(false);
        // And the real tree contains that second case, so this is not an invented risk.
        const recent = FILES.find(([f]) => f.endsWith('api/recentWork.ts'));
        expect(recent, 'recentWork.ts hoort in de scan te zitten').toBeTruthy();
        expect(computesLabel(recent[1])).toBe(false);
    });
});

describe('studioAppForKind', () => {
    it('geeft het registerrecord van de sectie die dat soort beheert', () => {
        expect(studioAppForKind('agent')?.id).toBe('agents');
        expect(studioAppForKind('kb')?.id).toBe('knowledge');
    });

    it('eerste treffer wint — twee secties kunnen dezelfde soort dragen', () => {
        for (const kind of new Set(STUDIO_APPS.filter((a) => a.kind).map((a) => a.kind))) {
            const first = STUDIO_APPS.find((a) => a.kind === kind);
            expect(studioAppForKind(kind)?.id, kind).toBe(first?.id);
        }
    });

    it('null voor een soort die het register niet kent, en voor niets', () => {
        expect(studioAppForKind('nope')).toBeNull();
        expect(studioAppForKind(null)).toBeNull();
        expect(studioAppForKind(undefined)).toBeNull();
    });
});

describe('studioGateContext', () => {
    const base = { user: {}, hasLicenseFeature: () => true, hasPermission: () => true, can: () => true };

    it('houdt lockReason weg zolang het antwoord niet echt is', () => {
        const loading = studioGateContext({ ...base, lockReason: () => 'ceiling', entitlementsLoading: true });
        expect(loading.lockReason('apps')).toBeNull();
        const failed = studioGateContext({ ...base, lockReason: () => 'ceiling', entitlementsError: new Error('x') });
        expect(failed.lockReason('apps')).toBeNull();
        const real = studioGateContext({ ...base, lockReason: () => 'ceiling' });
        expect(real.lockReason('apps')).toBe('ceiling');
    });
});

// "Only the parts they have rights to": who gets Studio, which sections it
// holds, and what a direct URL may open — the decisions the sidebar, the rail
// and the shell take together.
describe('Studio by section access', () => {
    // A fully licensed org with Meeting Notes on for everyone; the role is the
    // only thing that varies between the people below.
    const FEATURES = ['automations', 'approvals', 'webpages', 'app_studio', 'projects', 'meeting_notes'];
    const ctxFor = (user) => studioGateContext({
        user,
        hasLicenseFeature: (f) => FEATURES.includes(f),
        hasPermission: (p) => (user.permissions || []).includes('all') || (user.permissions || []).includes(p),
        can: () => true,
        lockReason: () => null,
    });
    const sectionsFor = (user) => studioNavSections(STUDIO_APPS, ctxFor(user));
    const ALL_ON = Object.fromEntries(FEATURES.map((f) => [f, true]));
    const member = (permissions) => ({ orgRole: 'member', permissions, canUseFeature: ALL_ON });
    const admin = { isAdmin: true, orgRole: 'org_admin', permissions: ['all'] };
    const ids = (sections) => sections.map((s) => s.id);
    const accessFor = (user, section) => studioSectionAccess({
        section, apps: [STUDIO_START, ...STUDIO_APPS], user,
        hasPermission: ctxFor(user).hasPermission, sections: sectionsFor(user),
    });

    it('a member with use_meeting_notes gets Studio, holding Meeting Notes (and Documents, which is everyone\'s)', () => {
        const user = member(['use_meeting_notes']);
        const sections = sectionsFor(user);
        expect(ids(sections)).toEqual(['documents', 'meetingNotes']);
        expect(ids(studioEntrySections(sections))).toEqual(['meetingNotes']);
        expect(canSeeStudio({ user, sections })).toBe(true);
        expect(studioLanding({ user, sections }).id).toBe('meetingNotes');
    });

    it('a member with only use_notebooks gets no Studio — notebooks live in Documents, which has its own row', () => {
        const user = member(['use_notebooks']);
        const sections = sectionsFor(user);
        expect(ids(sections)).toEqual(['documents']);
        expect(canSeeStudio({ user, sections })).toBe(false);
        expect(studioLanding({ user, sections })).toBeNull();
    });

    it('a member with nothing gets no Studio', () => {
        const user = member([]);
        expect(canSeeStudio({ user, sections: sectionsFor(user) })).toBe(false);
    });

    it('an admin sees every section, Start included, exactly as before', () => {
        const sections = sectionsFor(admin);
        expect(ids(sections)).toEqual(STUDIO_APPS.filter((a) => !a.hiddenFromNav).map((a) => a.id));
        expect(isStudioBuilder(admin)).toBe(true);
        expect(canSeeStudio({ user: admin, sections })).toBe(true);
        expect(studioLanding({ user: admin, sections }).id).toBe('agents');
        for (const section of ['start', ...STUDIO_APPS.map((a) => a.id)]) {
            expect(accessFor(admin, section), section).toEqual({ allowed: true, redirectTo: null });
        }
    });

    it('a builder keeps Studio even when every section of theirs is locked (the legacy rule stands)', () => {
        const user = { orgRole: 'member', permissions: ['manage_skills'] };
        expect(isStudioBuilder(user)).toBe(true);
        expect(canSeeStudio({ user, sections: [{ id: 'skills', locked: 'not_granted' }] })).toBe(true);
    });

    it('a locked section earns no Studio row; a topLevelEntrance one neither', () => {
        const user = member(['use_meeting_notes']);
        expect(canSeeStudio({ user, sections: [{ id: 'meetingNotes', locked: 'ceiling' }] })).toBe(false);
        expect(canSeeStudio({ user, sections: [{ id: 'documents', locked: null, topLevelEntrance: true }] })).toBe(false);
    });

    describe('a direct URL (studioSectionAccess)', () => {
        it('opens a section the role opens', () => {
            expect(accessFor(member(['use_meeting_notes']), 'meetingNotes')).toEqual({ allowed: true, redirectTo: null });
        });

        it('refuses one the role does not, and sends them to their own first section', () => {
            expect(accessFor(member(['use_meeting_notes']), 'webpages')).toEqual({ allowed: false, redirectTo: 'meeting-notes' });
            expect(accessFor(member(['use_meeting_notes']), 'agents')).toEqual({ allowed: false, redirectTo: 'meeting-notes' });
        });

        it('refuses with nowhere to go when nothing in Studio is theirs', () => {
            expect(accessFor(member([]), 'meetingNotes')).toEqual({ allowed: false, redirectTo: null });
        });

        it('sends a non-builder from Start to their first section — Start is a builder\'s dashboard', () => {
            expect(accessFor(member(['use_meeting_notes']), 'start')).toEqual({ allowed: false, redirectTo: 'meeting-notes' });
        });

        it('leaves Documents, Approvals (own entrance, e-mail links) and unknown ids alone', () => {
            const user = member([]);
            expect(accessFor(user, 'documents').allowed).toBe(true);
            expect(accessFor(user, 'approvals').allowed).toBe(true);
            expect(accessFor(user, 'some-module').allowed).toBe(true);
        });

        it('does not refuse on a licence miss — that is the section\'s (or the server\'s) to explain', () => {
            const user = member(['use_webpages', 'use_meeting_notes']);
            const unlicensed = studioGateContext({
                user, hasLicenseFeature: () => false, hasPermission: (p) => user.permissions.includes(p),
                can: () => false, lockReason: () => 'ceiling',
            });
            expect(studioSectionAccess({
                section: 'webpages', apps: STUDIO_APPS, user,
                hasPermission: unlicensed.hasPermission, sections: studioNavSections(STUDIO_APPS, unlicensed),
            }).allowed).toBe(true);
        });
    });
});
