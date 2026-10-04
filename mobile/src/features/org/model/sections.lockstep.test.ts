/**
 * The org index is the web's, in the web's order: orgInfoShared.jsx SECTIONS,
 * then AdvancedSettings.jsx BASE_ORG_SUB_ITEMS after its `...ORG_SECTIONS`
 * spread, then AZURE_SUB_ITEM. Ids and label keys are compared textually.
 */

import fs from 'node:fs';
import path from 'node:path';

import { WEB_ONLY_ORG_SECTIONS, WEB_ORG_SECTIONS } from './sections';

const WEB = path.resolve(__dirname, '../../../../../agent-hub/src');

function rows(src: string, marker: RegExp): { id: string; labelKey: string }[] {
    const body = marker.exec(src)?.[1] ?? '';
    return [...body.matchAll(/\{\s*id:\s*'([^']+)',\s*labelKey:\s*'([^']+)'/g)].map((m) => ({
        id: m[1] as string,
        labelKey: m[2] as string,
    }));
}

describe('the organisation sections', () => {
    const shared = fs.readFileSync(path.join(WEB, 'components/admin/org/orgInfo/orgInfoShared.jsx'), 'utf8');
    const settings = fs.readFileSync(path.join(WEB, 'pages/AdvancedSettings.jsx'), 'utf8');
    const web = [
        ...rows(shared, /const SECTIONS\s*=\s*\[([\s\S]*?)\];/),
        ...rows(settings, /const BASE_ORG_SUB_ITEMS\s*=\s*\[([\s\S]*?)\];/),
        ...rows(settings, /const AZURE_SUB_ITEM\s*=\s*(\{[^}]*\})/),
    ];

    it('reads both web lists', () => {
        expect(web.length).toBeGreaterThanOrEqual(16);
        expect(settings).toMatch(/BASE_ORG_SUB_ITEMS\s*=\s*\[\s*\.\.\.ORG_SECTIONS/);
    });

    it('lists the same sections, with the same label keys, in the same order', () => {
        // Minus the sections the phone leaves to the web on purpose.
        const offered = web.filter((r) => !WEB_ONLY_ORG_SECTIONS.includes(r.id));
        expect(WEB_ORG_SECTIONS.map(({ id, labelKey }) => ({ id, labelKey }))).toEqual(offered);
    });

    it('every web-only section still exists on the web (no stale exception)', () => {
        for (const id of WEB_ONLY_ORG_SECTIONS) expect(web.map((r) => r.id)).toContain(id);
    });
});
