/**
 * The phone's section tabs and moved tabs, held to the web rail
 * (agent-hub admin/compliance/sections.js, read as text), and every tab label
 * key held to both dictionaries.
 */

import fs from 'node:fs';
import path from 'node:path';

import { CLIENT_DICT, SERVER_DICT, readDict } from '@/core/i18n/dictionaryText';

import { LEGACY_TABS, SECTIONS, sectionById, tabLabel, tabsOfSection, type MovedTab } from './sections';

const REPO = path.resolve(__dirname, '../../../../..');
const SRC = fs.readFileSync(path.join(REPO, 'agent-hub/src/components/admin/compliance/sections.js'), 'utf8');

interface WebSection {
    tabs: string[];
    legacy: Record<string, Record<string, string>>;
}

/** Each web section's declaration, from its id to the next one. */
function webSections(): Map<string, WebSection> {
    const frameworkTabs = /const FRAMEWORK_TABS = Object\.freeze\(\[([^\]]*)\]\)/.exec(SRC)?.[1] ?? '';
    const quoted = (s: string) => [...s.matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1] as string);
    const starts = [...SRC.matchAll(/(fw|reg)\('([a-z_0-9]+)'|id: '([a-z_]+)', group:/g)];
    const out = new Map<string, WebSection>();
    starts.forEach((m, i) => {
        const chunk = SRC.slice(m.index, starts[i + 1]?.index ?? SRC.length);
        const tabsSrc = /tabs: Object\.freeze\(\[([^\]]*)\]\)/.exec(chunk)?.[1];
        const tabs = tabsSrc === undefined ? (m[1] === 'fw' ? quoted(frameworkTabs) : []) : [...(tabsSrc.includes('...FRAMEWORK_TABS') ? quoted(frameworkTabs) : []), ...quoted(tabsSrc)];
        const legacySrc = /legacy\(\{(.*)\}\)/.exec(chunk)?.[1] ?? '';
        const legacy = Object.fromEntries(
            [...legacySrc.matchAll(/(\w+): \{([^}]*)\}/g)].map((l) => [l[1] as string, Object.fromEntries([...(l[2] as string).matchAll(/(\w+): '([^']*)'/g)].map((p) => [p[1], p[2]]))]),
        );
        out.set((m[2] ?? m[3]) as string, { tabs, legacy });
    });
    return out;
}

const WEB = webSections();

/** The phone's reading of a web legacy target: the overview calendar is a page, obligations their own Training tab. */
function onPhone(target: Record<string, string>): MovedTab {
    if (target.section === 'overview' && target.tab === 'calendar') return { page: 'calendar' };
    if (target.section === 'training' && !target.tab) return { section: 'training', tab: 'obligations' };
    return target;
}

describe('the section tabs', () => {
    it('read every web section', () => {
        expect([...WEB.keys()]).toEqual(SECTIONS.map((s) => s.id));
    });

    it.each(['gdpr', 'aia', 'iso', 'nis2', 'dsr', 'soa', 'audits'])('%s has the web tabs, in order', (id) => {
        expect(tabsOfSection(sectionById(id)!).map((t) => t.id)).toEqual(WEB.get(id)?.tabs);
    });

    it('move the web legacy tabs to the same place, plus the overview calendar', () => {
        const web: Record<string, Record<string, MovedTab>> = {};
        for (const [id, s] of WEB) {
            if (Object.keys(s.legacy).length) web[id] = Object.fromEntries(Object.entries(s.legacy).map(([tab, to]) => [tab, onPhone(to)]));
        }
        expect(Object.keys(web).length).toBeGreaterThan(3);
        expect(LEGACY_TABS).toEqual({ ...web, overview: { calendar: { page: 'calendar' } } });
    });

    it('label every tab with a key both dictionaries have', () => {
        const client = readDict(CLIENT_DICT);
        const server = readDict(SERVER_DICT);
        const missing = SECTIONS.flatMap((s) => tabsOfSection(s).map((t) => tabLabel(s.id, t.id).i18nKey))
            .filter((key) => key.startsWith('compliance.tab_'))
            .filter((key) => !client.has(key) || !server.has(key));
        expect(missing).toEqual([]);
    });
});
