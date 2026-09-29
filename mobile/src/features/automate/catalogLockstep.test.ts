/**
 * The phone's component coverage, measured against the real catalog.
 *
 * The web has a lockstep test for exactly this reason
 * (agent-hub/.../runtime/catalogLockstep.test.js): the catalog in
 * server/appStudio/componentSpecs.js is the schema contract, and a mirror that
 * nothing checks drifts. The phone had no such test, and its hand-typed
 * SUPPORTED_INPUTS carried a comment saying "from FORM_SPECS" with nothing
 * enforcing it — so the gap widened silently, and by the time anyone looked the
 * renderer drew 13 of 52 types with `page_header` (12 of 12 templates) missing
 * while `heading` (4 of 12) was drawn.
 *
 * This does NOT demand that the phone draw everything. It demands that every
 * catalog type be ACCOUNTED FOR — drawn, deliberately left to the browser, or
 * explicitly listed as not yet built. Adding a component on the server fails
 * this test until someone decides which of the three it is, which is the whole
 * point: the decision gets made by a person rather than by omission.
 *
 * Requires the server file directly. It is plain CommonJS with no third-party
 * imports, so no transform or install is needed.
 */

import {
    BROWSER_ONLY_TYPES,
    HANDLED_TYPES,
    SUPPORTED_INPUTS,
} from './appDefinition';

// The catalog is CommonJS on the server and is deliberately read from there
// rather than copied — a copy is the thing this test exists to make
// unnecessary.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const catalog = require('../../../../server/appStudio/componentSpecs.js') as {
    COMPONENT_TYPES: string[];
    CONTAINER_TYPES: string[];
    INPUT_TYPES: string[];
};

/**
 * Types the phone does not draw yet and has not ruled out. Shrinking this list
 * is the roadmap; every entry is a real app screen that reads as a banner.
 */
const NOT_YET_BUILT = [
    'image',
    'keyValue',
    'table',
    'list',
    'approval_list',
    'data_grid',
    'chart',
    'input_file',
    'input_dataset',
    'input_richtext',
    // Landed on the server 2026-09 (Studio/datatables batch) while mobile CI
    // did not yet run on server/** — the exact gap that trigger now closes.
    // Same family and same verdict as input_richtext: an HTML editor on a
    // phone keyboard is a project, not a checkbox.
    'input_html',
    'input_datetime',
    'input_relation',
    'input_person',
    'input_multiselect',
    'tabs',
    'tab',
    'modal',
    'repeater',
    'pane',
    'markdown',
    'badge_list',
    'progress',
    'stepper',
    'file_gallery',
    'connector_status',
    'timeline',
    'message_thread',
    'record_detail',
    'filter_bar',
    'calendar',
    'ai_chat',
];

describe('the phone against the App Studio catalog', () => {
    it('reads the real catalog', () => {
        expect(catalog.COMPONENT_TYPES.length).toBeGreaterThan(40);
        expect(catalog.COMPONENT_TYPES).toContain('page_header');
    });

    it('claims to support only inputs that exist in the catalog', () => {
        for (const input of SUPPORTED_INPUTS) {
            expect(catalog.INPUT_TYPES).toContain(input);
        }
    });

    it('handles only types that exist in the catalog', () => {
        for (const type of HANDLED_TYPES) {
            expect(catalog.COMPONENT_TYPES).toContain(type);
        }
    });

    it('rules out only types that exist in the catalog', () => {
        for (const type of Object.keys(BROWSER_ONLY_TYPES)) {
            expect(catalog.COMPONENT_TYPES).toContain(type);
        }
        for (const type of NOT_YET_BUILT) {
            expect(catalog.COMPONENT_TYPES).toContain(type);
        }
    });

    it('accounts for EVERY catalog type exactly once', () => {
        const accounted = [
            ...HANDLED_TYPES,
            ...Object.keys(BROWSER_ONLY_TYPES),
            ...NOT_YET_BUILT,
        ];
        expect(new Set(accounted).size).toBe(accounted.length);

        const missing = catalog.COMPONENT_TYPES.filter((t) => !accounted.includes(t));
        expect(missing).toEqual([]);

        expect(accounted.sort()).toEqual([...catalog.COMPONENT_TYPES].sort());
    });

    it('draws every container it walks into, or names it', () => {
        // A container the walker neither recurses into nor reports would lose
        // its children with no trace — the failure mode that hid a modal's
        // contents inline and dropped a form's headings entirely.
        for (const type of catalog.CONTAINER_TYPES) {
            const known =
                (HANDLED_TYPES as readonly string[]).includes(type) ||
                type in BROWSER_ONLY_TYPES ||
                NOT_YET_BUILT.includes(type);
            expect(known).toBe(true);
        }
    });
});
