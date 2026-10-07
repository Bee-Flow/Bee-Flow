/**
 * The register registry: one entry per type, every records section resolves
 * its types, and a junk payload reads as an empty register. The per-register
 * request tests live with each register's own package.
 */

import { NCS } from './recordsAudit';
import { RECORD_TYPES, recordType, typesOfSection } from './registry';
import { SECTIONS } from './sections';

describe('the registry', () => {
    it('has one entry per id, and every records section resolves its types', () => {
        expect(new Set(RECORD_TYPES.map((x) => x.id)).size).toBe(RECORD_TYPES.length);
        for (const section of SECTIONS.filter((s) => s.view === 'records')) {
            expect(typesOfSection(section).length).toBe(section.types?.length);
        }
        expect(recordType('ncs')).toBe(NCS);
        expect(recordType('nope')).toBeNull();
    });

    it('reads a junk payload as an empty register, never a throw', () => {
        for (const type of RECORD_TYPES) {
            const set = type.list.select(type.list.paths.map(() => '<html>'));
            expect(set.rows).toEqual([]);
        }
    });
});
