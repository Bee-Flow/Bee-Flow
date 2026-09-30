/**
 * Every step type the server can run is ACCOUNTED FOR on the phone.
 *
 * Same shape, and the same reason, as catalogLockstep.test.ts beside it: a
 * mirror that nothing checks drifts. The run timeline printed `step.stepType`
 * raw, so a phone read "integration_action · 1.2s" and "knowledge_write"
 * where the browser, on the very same run, said "Action" and "To knowledge
 * base". One run must not read as two different routines depending on the
 * screen.
 *
 * This does NOT demand a pretty name for everything. It demands a DECISION:
 * named in STEP_TYPE_NAMES, or listed in UNNAMED_STEP_TYPES with a reason.
 * Adding a step type on the server fails this test until a person picks one,
 * which is exactly the failure mode it exists to prevent — the default today
 * is a snake_case token on a customer's screen, chosen by nobody.
 *
 * The registry is required straight from the server. builtinStepTools.js is
 * plain CommonJS with no third-party imports, so no transform and no install
 * is needed — and reading it is the half a copied list cannot fake.
 *
 * Run: cd mobile && ./node_modules/.bin/jest src/features/automations/model/stepLockstep.test.ts
 */

import { STEP_TYPE_NAMES, UNNAMED_STEP_TYPES, stepTypeName } from './stepNames';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const registry = require('../../../../../server/automation/builtinStepTools.js') as {
    STEP_TYPES: Set<string>;
    ALIASES: Record<string, string>;
};

const SERVER_TYPES = [...registry.STEP_TYPES].sort();

describe('the server registry is real', () => {
    it('loads, and is not empty — an empty set would pass everything below', () => {
        expect(SERVER_TYPES.length).toBeGreaterThan(20);
        expect(SERVER_TYPES).toContain('integration_action');
    });
});

describe('every server step type is accounted for', () => {
    it.each(SERVER_TYPES)('%s', (type) => {
        const named = Object.prototype.hasOwnProperty.call(STEP_TYPE_NAMES, type);
        const deferred = Object.prototype.hasOwnProperty.call(UNNAMED_STEP_TYPES, type);
        expect(
            named || deferred,
            // The message is the instruction, because the person who trips
            // this is adding a step type and has never read this file.
        ).toBe(true);
    });

    it('a deferred type carries a REASON, not just a key', () => {
        for (const [type, why] of Object.entries(UNNAMED_STEP_TYPES)) {
            expect(typeof why === 'string' && why.trim().length > 10).toBe(true);
            expect(STEP_TYPE_NAMES[type]).toBeUndefined();
        }
    });
});

describe('the names are names', () => {
    it.each(Object.entries(STEP_TYPE_NAMES))('%s reads as words, not as an identifier', (type, name) => {
        // The entire point: no underscores, no camelCase, and never the type
        // itself echoed back as though it were a label.
        expect(name).not.toContain('_');
        expect(name).not.toBe(type);
        // Non-empty is part of the claim, not a precondition of it: a name of
        // '' would pass both lines above and print nothing on the screen.
        expect(name.length).toBeGreaterThan(0);
        expect(name.slice(0, 1)).toBe(name.slice(0, 1).toUpperCase());
    });

    it('the three runtime shapes of the Condition node share one name', () => {
        // routeModel.js fronts condition/switch/filter with a single palette
        // entry, so a run that says "Condition" for one and "Filter" for
        // another would be describing a distinction the author never made.
        expect(stepTypeName('condition')).toBe('Condition');
        expect(stepTypeName('switch')).toBe('Condition');
        expect(stepTypeName('filter')).toBe('Condition');
    });
});

describe('a type this build has never heard of', () => {
    it('is printed as itself rather than swallowed', () => {
        // A server can be newer than the app — the upgrade programme is built
        // on that. A step we cannot name is still a step that ran, and the
        // identifier is the only clue left about what that row was.
        expect(stepTypeName('invented_next_year')).toBe('invented_next_year');
    });

    it('nothing at all stays nothing, rather than becoming a word', () => {
        expect(stepTypeName(null)).toBeNull();
        expect(stepTypeName(undefined)).toBeNull();
        expect(stepTypeName('   ')).toBeNull();
    });
});

describe('the aliases the server accepts are not step types', () => {
    it('is not confused into naming them', () => {
        // `webhook` and `api_call` are names a MODEL reaches for; the registry
        // maps them onto real types. Naming them here would put a word on
        // screen for something no run ever produces.
        for (const alias of Object.keys(registry.ALIASES)) {
            expect(STEP_TYPE_NAMES[alias]).toBeUndefined();
        }
    });
});
