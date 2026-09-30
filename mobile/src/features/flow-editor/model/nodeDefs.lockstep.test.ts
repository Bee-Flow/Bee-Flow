/**
 * The node catalogue, pinned three ways:
 *   - DIFFERENTIAL against the web's flow/nodeDefs.js (every record, the key
 *     order, the exemption lists and the accessors);
 *   - TEXTUAL against the server: every type VALID_STEP_TYPES accepts has a
 *     record, and every non-canvas record is a type the server accepts;
 *   - the model's own STEP_TYPES / trigger / edge vocabularies against the
 *     server's constants.
 * A new server step type fails here until someone describes it.
 */

import path from 'node:path';

import * as defs from './nodeDefs';
import { EDGE_COLOR_KEYS, isStepType, KNOWN_EDGE_LABELS, SECONDARY_TRIGGER_KINDS, STEP_TYPES, TRIGGER_KINDS } from './types';

const REPO = path.resolve(__dirname, '../../../../..');
/* eslint-disable @typescript-eslint/no-require-imports */
const web = require(path.join(REPO, 'agent-hub/src/components/automation/Builder/flow/nodeDefs.js'));
const webTriggerLabels = require(path.join(REPO, 'agent-hub/src/components/automation/Builder/flow/triggerLabels.js'));
const server = require(path.join(REPO, 'server/automation/validate/constants.js'));
/* eslint-enable @typescript-eslint/no-require-imports */

const SERVER_TYPES = [...(server.VALID_STEP_TYPES as Set<string>)].sort();

describe('against the web', () => {
    it('every record is identical, in the same order', () => {
        expect(defs.NODE_DEFS).toEqual(web.NODE_DEFS);
        expect(defs.NODE_TYPE_KEYS).toEqual(web.NODE_TYPE_KEYS);
    });

    it('the exemption lists and families are identical', () => {
        expect(defs.PALETTE_ABSENT).toEqual(web.PALETTE_ABSENT);
        expect(defs.SYNTHETIC_TYPES).toEqual(web.SYNTHETIC_TYPES);
        expect(defs.FAMILY_EXEMPT).toEqual(web.FAMILY_EXEMPT);
        expect([...defs.NODE_FAMILIES]).toEqual(web.NODE_FAMILIES);
        expect(defs.FLAT).toBe(web.FLAT);
    });

    const t = (key: string, fallback: string) => `${key}|${fallback}`;
    it.each([...defs.NODE_TYPE_KEYS, 'nope', ''])('the accessors agree for %j, with and without t', (type) => {
        for (const fn of ['nodeTypeLabel', 'nodeDefaultLabel', 'nodeHelp', 'nodeLabel', 'nodeDesc'] as const) {
            const port = (defs as Record<string, unknown>)[fn] as typeof defs.nodeLabel;
            expect(port(type)).toBe(web[fn](type));
            expect(port(type, t)).toBe(web[fn](type, t));
        }
        expect(defs.stepFamily(type)).toBe(web.stepFamily(type));
    });

    it('answers unknowns plainly', () => {
        expect(defs.stepFamily(null)).toBeNull();
        expect(defs.nodeDef('set')).toBe(defs.NODE_DEFS.set);
        expect(defs.nodeDef(undefined)).toBeUndefined();
        expect(defs.nodeDef('constructor')).toBeUndefined();
    });
});

describe('against the server', () => {
    it('the server list is real', () => {
        expect(SERVER_TYPES.length).toBeGreaterThan(30);
    });

    it.each(SERVER_TYPES)('%s has a presentation record with a family decision', (type) => {
        const def = defs.nodeDef(type);
        expect(def).toBeDefined();
        expect(def?.family !== null || Object.prototype.hasOwnProperty.call(defs.FAMILY_EXEMPT, type)).toBe(true);
        expect(def?.issueSections?.fallback).toBeTruthy();
    });

    it('every record that is not canvas-only is a type the server runs', () => {
        const real = defs.NODE_TYPE_KEYS.filter((type) => !defs.SYNTHETIC_TYPES[type]).sort();
        expect(real).toEqual(SERVER_TYPES);
    });

    it('STEP_TYPES is the server list', () => {
        expect([...STEP_TYPES].sort()).toEqual(SERVER_TYPES);
        expect(isStepType('set')).toBe(true);
        expect(isStepType('loop_item')).toBe(false);
        expect(isStepType(4)).toBe(false);
    });

    it('the edge and trigger vocabularies are the server\'s', () => {
        expect([...KNOWN_EDGE_LABELS].sort()).toEqual([...server.KNOWN_EDGE_LABELS].sort());
        expect([...EDGE_COLOR_KEYS].sort()).toEqual([...server.EDGE_COLOR_KEYS].sort());
        expect([...SECONDARY_TRIGGER_KINDS].sort()).toEqual([...server.SECONDARY_TRIGGER_KINDS].sort());
        expect([...TRIGGER_KINDS].sort()).toEqual(Object.keys(webTriggerLabels.TRIGGER_TYPE_LABEL).sort());
    });
});
