/**
 * The org index is the web's, in the web's order: orgInfoShared.tsx SECTIONS,
 * then AdvancedSettings.jsx BASE_ORG_SUB_ITEMS after its `...ORG_SECTIONS`
 * spread, then AZURE_SUB_ITEM. The web's list is read from its GUI inventory
 * golden (authedApp/settingsRoutes.inventory.golden.json `phoneOrgList`,
 * recorded by settingsRoutes.inventory.test.ts: the spread expanded from the
 * running SECTIONS, the rest read from AdvancedSettings' syntax tree). Ids and
 * label keys are compared.
 */

import { webGolden } from '@/shared/testing/webModule';

import { WEB_ONLY_ORG_SECTIONS, WEB_ORG_SECTIONS } from './sections';

interface GoldenRow {
    id?: string;
    labelKey?: string;
}

describe('the organisation sections', () => {
    const golden = webGolden<{ phoneOrgList: GoldenRow[] }>('authedApp/settingsRoutes.inventory.golden.json');
    const web = golden.phoneOrgList.map(({ id, labelKey }) => ({ id: id as string, labelKey: labelKey as string }));

    it('reads the web list', () => {
        expect(web.length).toBeGreaterThanOrEqual(16);
        // A row the inventory could not read (a spread of something else) has no id.
        expect(web.every((r) => r.id && r.labelKey)).toBe(true);
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
