/**
 * The Compliance Center deep links, held to features/compliance: every
 * section and every old alias it accepts must open where its own hub would
 * (model/navigation.ts targetRoute over model/sections.ts sectionById), with
 * and without a record id. routeCompliance.ts ports those rules rather than
 * importing them (see routeOrg.ts); this is the link between the two.
 */

import fs from 'node:fs';
import path from 'node:path';

import { targetRoute } from '@/features/compliance/model/navigation';
import { SECTIONS, sectionById } from '@/features/compliance/model/sections';

import { translateWebLink } from './route';
import { COMPLIANCE_ALIASES, COMPLIANCE_SECTION_IDS } from './routeCompliance';

const SECTIONS_SRC = path.resolve(__dirname, '../../compliance/model/sections.ts');

/** The ALIASES table of sections.ts, read from its source (it is not exported). */
function sourceAliases(): Record<string, string> {
    const src = fs.readFileSync(SECTIONS_SRC, 'utf8');
    const body = /const ALIASES[^=]*=\s*\{([\s\S]*?)\};/.exec(src)?.[1] ?? '';
    return Object.fromEntries([...body.matchAll(/(\w+):\s*'([^']+)'/g)].map((m) => [m[1] as string, m[2] as string]));
}

describe('the Compliance Center deep links', () => {
    it('know every section, and only those', () => {
        expect([...COMPLIANCE_SECTION_IDS].sort()).toEqual(SECTIONS.map((s) => s.id).sort());
    });

    it('know every old alias the hub accepts, onto the same section', () => {
        const aliases = sourceAliases();
        expect(Object.keys(aliases).length).toBeGreaterThan(5);
        expect(COMPLIANCE_ALIASES).toEqual(aliases);
    });

    it.each([...SECTIONS.map((s) => s.id), ...Object.keys(COMPLIANCE_ALIASES)].map((id) => [id]))(
        '/app/admin/compliance/%s opens where the hub would',
        (segment) => {
            const section = sectionById(segment)?.id as string;
            expect(translateWebLink(`/app/admin/compliance/${segment}`)?.href).toBe(targetRoute({ section, id: null }));
            expect(translateWebLink(`/app/admin/compliance/${segment}/x1`)?.href).toBe(targetRoute({ section, id: 'x1' }));
            expect(translateWebLink(`/app/admin/compliance/${segment}?id=x1`)?.href).toBe(targetRoute({ section, id: 'x1' }));
        },
    );

    it('opens the hub for the Compliance Center itself, and says a section it does not know is only close', () => {
        expect(translateWebLink('/app/admin/compliance')).toEqual({ href: '/org/compliance' });
        expect(translateWebLink('/app/admin/compliance/some-new-register/r1')).toEqual({ href: '/org/compliance', approximate: true });
    });
});
