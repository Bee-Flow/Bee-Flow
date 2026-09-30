/**
 * One destination, one glyph: the sitemap's rows (the A–Z map and the global
 * search's places) draw the same icon as the drawer row or the Studio section
 * that opens the same screen — the web's glyph for it. The drawer's spec wins
 * where both have the address (Agents: the directory's Store, not the
 * builder's Bot).
 */

import { DESTINATIONS } from '@/features/sitemap';
import { STUDIO_SECTIONS } from '@/features/studio';

import { CORE_NAV, SECONDARY_NAV } from './nav';

function glyphByHref(): Map<string, string> {
    const out = new Map<string, string>();
    for (const section of STUDIO_SECTIONS) {
        // Solutions open the project list, which the map files as Projects —
        // the web's own projects, drawn with the project's emoji, not Studio's Boxes.
        if (section.target.kind === 'route' && section.id !== 'solutions') out.set(section.target.href, section.icon);
    }
    // The New Chat row is the pen; the Chat destination is the tab, with the tab's glyph.
    for (const row of [...CORE_NAV, ...SECONDARY_NAV]) if (row.key !== 'new-chat') out.set(row.href, row.icon);
    return out;
}

describe('destination glyphs', () => {
    it('draw every shared destination as the drawer and Studio draw it', () => {
        const expected = glyphByHref();
        const drift = DESTINATIONS.filter((d) => expected.has(d.href) && expected.get(d.href) !== d.icon).map(
            (d) => `${d.id}: ${d.icon}, expected ${expected.get(d.href)}`,
        );
        expect(drift).toEqual([]);
    });

    it('covers the rows the review found apart', () => {
        const byId = new Map(DESTINATIONS.map((d) => [d.id, d.icon]));
        expect(Object.fromEntries(['cowork', 'agents', 'notebooks', 'knowledge', 'skills', 'apps', 'approvals', 'automations', 'webpages', 'forms'].map((id) => [id, byId.get(id)]))).toEqual({
            cowork: 'Handshake',
            agents: 'Store',
            notebooks: 'FileText',
            knowledge: 'BookOpen',
            skills: 'Sparkles',
            apps: 'AppWindow',
            approvals: 'ShieldCheck',
            automations: 'ListChecks',
            webpages: 'Globe',
            forms: 'ClipboardList',
        });
    });
});
