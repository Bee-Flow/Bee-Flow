/**
 * The deep-link table's Studio half, held to the Studio registry.
 *
 * routeStudio.ts cannot import features/studio at runtime (it would close a
 * cycle through the features that read notifications), so this test is the
 * link: for every registry section, a link to the section and to one object
 * in it must land where the registry says that section opens — its native
 * list or detail screen, or, for a section the phone has no screen for, the
 * Studio hub marked approximate. A new Studio section fails here until the
 * table knows it.
 */

import { DATATABLE_TABS } from '@/features/datatables';
import { STUDIO_SECTIONS } from '@/features/studio';

import { translateWebLink } from './route';
import { DATATABLE_WEB_TABS } from './routeStudio';

/** expo-router ignores groups: `/(tabs)/record` is `/record`. */
const strip = (href: string | null | undefined) => (href ?? '').replace(/\/\([^)]+\)/g, '') || '/';

describe('every Studio section deep-links where the registry says it opens', () => {
    it.each(STUDIO_SECTIONS.map((s) => [s.segment, s] as const))('/app/studio/%s', (segment, section) => {
        const list = translateWebLink(`/app/studio/${segment}`);
        const one = translateWebLink(`/app/studio/${segment}/x1`);
        if (section.target.kind === 'web') {
            expect(list).toEqual({ href: '/studio', approximate: true });
            expect(one).toEqual({ href: '/studio', approximate: true });
            return;
        }
        expect(strip(list?.href)).toBe(section.target.href);
        expect(list?.approximate).toBeFalsy();
        const detail = section.target.detail ? section.target.detail('x1') : section.target.href;
        expect(strip(one?.href)).toBe(detail);
    });

    it.each(STUDIO_SECTIONS.map((s) => [s.segment, s] as const))('/app/studio/%s/new lands where the New menu does', (segment, section) => {
        const landed = translateWebLink(`/app/studio/${segment}/new`);
        const target = section.create?.target ?? section.target;
        if (target.kind === 'web') {
            expect(landed).toEqual({ href: '/studio', approximate: true });
            return;
        }
        expect(strip(landed?.href)).toBe(target.href);
    });

    it.each(STUDIO_SECTIONS.flatMap((s) => (s.legacySegments ?? []).map((legacy) => [legacy, s.segment] as const)))(
        'the legacy segment %s lands like %s',
        (legacy, segment) => {
            expect(translateWebLink(`/app/studio/${legacy}/x1`)).toEqual(translateWebLink(`/app/studio/${segment}/x1`));
        },
    );
});

describe('datatable tabs', () => {
    it('opens only the tabs the phone’s table screen has', () => {
        expect([...DATATABLE_WEB_TABS].sort()).toEqual([...DATATABLE_TABS].sort());
    });
});
