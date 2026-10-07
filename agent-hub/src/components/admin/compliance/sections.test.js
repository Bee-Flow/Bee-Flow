import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    SECTIONS, GROUPS, DEFAULT_SECTION, SECTIONS_WITH_PICKERS, SECTION_FOR_REGULATION,
    resolveSection, sectionById, frameworkOf, sectionForRegulation, tabsOf, sectionsInGroup, tabLabelKey, resolveTab,
} from './sections';

const here = path.dirname(fileURLToPath(import.meta.url));

// The rail keys are new and travel to the dictionaries through the
// integrator's merge of .claude/handoff/compliance/keys/*.json — so a key is
// "known" when EITHER dictionary source has it. Once the merge has landed the
// keys file can be deleted and this test keeps passing on en-defaults alone.
function knownKeys() {
    const known = new Set();
    const en = fs.readFileSync(path.join(here, '..', '..', '..', 'i18n', 'en-defaults.js'), 'utf8');
    for (const m of en.matchAll(/"(compliance\.[a-z0-9_]+)":/g)) known.add(m[1]);
    const keysDir = path.join(here, '..', '..', '..', '..', '..', '.claude', 'handoff', 'compliance', 'keys');
    if (fs.existsSync(keysDir)) {
        for (const f of fs.readdirSync(keysDir).filter(f => f.endsWith('.json'))) {
            const body = JSON.parse(fs.readFileSync(path.join(keysDir, f), 'utf8'));
            for (const k of Object.keys(body.en || {})) known.add(k);
        }
    }
    return known;
}

describe('compliance sections registry', () => {
    it('ids are unique and no alias collides with an id or another alias', () => {
        const ids = SECTIONS.map(s => s.id);
        expect(new Set(ids).size).toBe(ids.length);
        const aliases = SECTIONS.flatMap(s => s.aliases);
        expect(new Set(aliases).size).toBe(aliases.length);
        for (const a of aliases) expect(ids).not.toContain(a);
    });

    it('every group id on a section is a declared group, in rail order Kaders → Registers → Beheer', () => {
        expect(GROUPS.map(g => g.id)).toEqual(['frameworks', 'registers', 'admin']);
        for (const s of SECTIONS) if (s.group) expect(GROUPS.some(g => g.id === s.group)).toBe(true);
        const order = SECTIONS.filter(s => s.group).map(s => GROUPS.findIndex(g => g.id === s.group));
        expect([...order].sort((a, b) => a - b)).toEqual(order);
        expect(sectionsInGroup('admin').map(s => s.id)).toEqual(['settings', 'connectors']);
    });

    it('every old id still resolves — no bookmark breaks', () => {
        expect(resolveSection('iso_overview')).toBe('iso');
        expect(resolveSection('iso_controls')).toBe('iso');
        expect(resolveSection('iso_soa')).toBe('soa');
        expect(resolveSection('iso_policies')).toBe('policies');
        expect(resolveSection('iso_risks')).toBe('risks');
        expect(resolveSection('iso_audit')).toBe('audits');
        expect(resolveSection('iso_training')).toBe('training');
        expect(resolveSection('iso_access_log')).toBe('access_log');
        expect(resolveSection('iso_connectors')).toBe('connectors');
        expect(resolveSection('kaders')).toBe('frameworks');
        // unchanged ids
        for (const id of ['overview', 'gdpr', 'aia', 'dsr', 'incidents', 'ropa', 'dpia', 'settings']) {
            expect(resolveSection(id)).toBe(id);
        }
    });

    it('unknown, empty and non-string ids fall back to the overview', () => {
        expect(resolveSection('nope')).toBe(DEFAULT_SECTION);
        expect(resolveSection('')).toBe(DEFAULT_SECTION);
        expect(resolveSection(undefined)).toBe(DEFAULT_SECTION);
        expect(resolveSection(null)).toBe(DEFAULT_SECTION);
        expect(sectionById('nope').id).toBe('overview');
    });

    it('frameworkOf scores the framework sections and answers null for registers and admin', () => {
        expect(frameworkOf('gdpr')).toBe('GDPR');
        expect(frameworkOf('aia')).toBe('AIA');
        expect(frameworkOf('iso')).toBe('ISO27001');
        expect(frameworkOf('iso_controls')).toBe('ISO27001');
        expect(frameworkOf('nis2')).toBe('NIS2');
        expect(frameworkOf('custom')).toBe('CUSTOM');
        for (const id of ['overview', 'frameworks', 'dsr', 'incidents', 'soa', 'risks', 'settings', 'connectors']) {
            expect(frameworkOf(id)).toBeNull();
        }
    });

    it('SECTION_FOR_REGULATION covers all eleven regulation codes and round-trips', () => {
        const codes = ['GDPR', 'AIA', 'ISO27001', 'NIS2', 'CRA', 'DATA_ACT', 'PLD', 'EAA', 'DORA', 'MACHINERY', 'CUSTOM'];
        expect(Object.keys(SECTION_FOR_REGULATION).sort()).toEqual([...codes].sort());
        for (const code of codes) expect(frameworkOf(sectionForRegulation(code))).toBe(code);
        expect(sectionForRegulation('NOPE')).toBe(DEFAULT_SECTION);
    });

    it('tabs follow the artboards', () => {
        expect(tabsOf('overview')).toEqual(['status', 'calendar', 'reports']);
        expect(tabsOf('gdpr')).toEqual(['checks', 'timeline', 'evidence']);
        expect(tabsOf('iso_controls')).toEqual(['checks', 'timeline', 'evidence']);
        expect(tabsOf('frameworks')).toEqual(['all', 'calendar', 'per_automation']);
        expect(tabsOf('dsr')).toEqual(['requests', 'public_form']);
        expect(tabsOf('soa')).toEqual(['controls', 'history', 'export']);
        expect(tabsOf('audits')).toEqual(['audits', 'reviews', 'ncs', 'objectives']);
        expect(tabsOf('incidents')).toEqual([]);
        expect(tabLabelKey('iso_soa', 'controls')).toBe('compliance.tab_soa_controls');
    });

    it('picker sections are real sections; the Access log fetches the directory to show names', () => {
        for (const id of SECTIONS_WITH_PICKERS) expect(resolveSection(id)).toBe(id);
        expect(SECTIONS_WITH_PICKERS).toContain('access_log');
    });

    it('resolveTab sends a tab that moved to where it went, and leaves a current tab alone', () => {
        expect(resolveTab('audits', 'obligations')).toEqual({ section: 'training', tab: null });
        expect(resolveTab('iso_audit', 'obligations')).toEqual({ section: 'training', tab: null });
        expect(resolveTab('audits', 'ncs')).toEqual({ section: 'audits', tab: 'ncs' });
        expect(resolveTab('dsr', 'settings')).toEqual({ section: 'settings', tab: null });
        expect(resolveTab('dsr', 'public_form')).toEqual({ section: 'dsr', tab: 'public_form' });
        expect(resolveTab('frameworks', 'calendar')).toEqual({ section: 'frameworks', tab: 'calendar' });
        expect(resolveTab('gdpr', null)).toEqual({ section: 'gdpr', tab: null });
        expect(resolveTab('nope', '')).toEqual({ section: 'overview', tab: null });
        // A key on Object.prototype is not a legacy tab.
        expect(resolveTab('audits', 'toString')).toEqual({ section: 'audits', tab: 'toString' });
    });

    it('every legacyTabs entry is frozen, leaves its section, lands on a real section and a tab it has', () => {
        for (const s of SECTIONS) {
            expect(Object.isFrozen(s.legacyTabs), s.id).toBe(true);
            for (const [oldTab, to] of Object.entries(s.legacyTabs)) {
                // A legacy tab that is still a live tab would redirect away from itself.
                expect(s.tabs, `${s.id}.${oldTab}`).not.toContain(oldTab);
                expect(resolveSection(to.section), `${s.id}.${oldTab}`).toBe(to.section);
                if (to.tab) expect(tabsOf(to.section), `${s.id}.${oldTab}`).toContain(to.tab);
                expect(to.section === s.id && !to.tab, `${s.id}.${oldTab} is a loop`).toBe(false);
            }
        }
    });

    it('every labelKey, group label and tab label names a key that exists (dictionary or pending keys file)', () => {
        const known = knownKeys();
        const missing = [];
        for (const g of GROUPS) if (!known.has(g.labelKey)) missing.push(g.labelKey);
        for (const s of SECTIONS) {
            if (!known.has(s.labelKey)) missing.push(s.labelKey);
            for (const tab of s.tabs) {
                const k = tabLabelKey(s.id, tab);
                if (!known.has(k)) missing.push(k);
            }
        }
        expect(missing).toEqual([]);
    });

    it('is a leaf: imports lucide-react and nothing else, and has no hex colours', () => {
        const src = fs.readFileSync(path.join(here, 'sections.js'), 'utf8');
        const imports = [...src.matchAll(/^import[\s\S]*?from '([^']+)';/gm)].map(m => m[1]);
        expect(imports).toEqual(['lucide-react']);
        expect(src).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    });
});
