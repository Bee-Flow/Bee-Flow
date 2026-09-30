/**
 * Simple / All options, pinned to the web's flow/settings/formDensity.js. That
 * module imports React (it holds a context too), so it is read as TEXT: the
 * advanced-section list and the per-type rule are compared, and the rule is
 * run over every type and section nodeDefs knows.
 */

import fs from 'node:fs';
import path from 'node:path';

import { NODE_DEFS, NODE_TYPE_KEYS } from '@/features/flow-editor/model';

import { ADVANCED_SECTION_KEYS, hiddenInSimple, hiddenSectionCount, sectionShown } from './density';

const REPO = path.resolve(__dirname, '../../../../../..');
const SRC = fs.readFileSync(path.join(REPO, 'agent-hub/src/components/automation/Builder/flow/settings/formDensity.js'), 'utf8');

describe('against formDensity.js', () => {
    it('hides the same section keys by default', () => {
        const block = /ADVANCED_SECTION_KEYS = new Set\(\[([\s\S]*?)\]\)/.exec(SRC)?.[1] ?? '';
        expect([...ADVANCED_SECTION_KEYS]).toEqual([...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
    });

    it('decides per type from simpleSections, and falls back to the global rule', () => {
        expect(SRC).toMatch(/const simple = NODE_DEFS\[stepType\]\?\.simpleSections;/);
        expect(SRC).toMatch(/if \(Array\.isArray\(simple\)\) return !simple\.includes\(sectionKey\);/);
        expect(SRC).toMatch(/return isAdvancedSection\(sectionKey\);/);
    });
});

describe('hiddenInSimple', () => {
    it.each(NODE_TYPE_KEYS)('%s: Simple keeps exactly its simpleSections', (type) => {
        const def = NODE_DEFS[type];
        for (const key of def?.sectionKeys ?? []) {
            const expected = Array.isArray(def?.simpleSections) ? !def.simpleSections.includes(key) : ADVANCED_SECTION_KEYS.has(key);
            expect({ type, key, hidden: hiddenInSimple(type, key) }).toEqual({ type, key, hidden: expected });
        }
    });

    it('never hides an error or a configured section, and hides nothing in All options', () => {
        expect(sectionShown('notification', 'advanced', { mode: 'simple' })).toBe(false);
        expect(sectionShown('notification', 'advanced', { mode: 'simple', hasError: true })).toBe(true);
        expect(sectionShown('notification', 'advanced', { mode: 'simple', hasContent: true })).toBe(true);
        expect(sectionShown('notification', 'advanced', { mode: 'advanced' })).toBe(true);
        expect(hiddenSectionCount('http_request', NODE_DEFS.http_request?.sectionKeys ?? [])).toBe(3);
        // A type nodeDefs does not know falls back to the global list.
        expect(hiddenInSimple('mystery', 'options')).toBe(true);
        expect(hiddenInSimple('mystery', 'config')).toBe(false);
    });
});
