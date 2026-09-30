/**
 * Test-only fixtures for the differential lockstep tests: the web's own
 * sample definitions (state/sampleDefinitions.js) plus one hand-made
 * definition (fixtures.json, WIRED) that exercises what the samples do not — dialogs referenced by
 * actions and nested sequence steps, every action surface a node can carry,
 * effects that navigate, variables, roles and broken ids.
 *
 * Never imported by app code.
 */

import type { AppDefinition } from '../types';
import { loadWeb } from './loadWeb';

export function deepFreeze<T>(obj: T): T {
    if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
        Object.freeze(obj);
        for (const value of Object.values(obj)) deepFreeze(value);
    }
    return obj;
}

// Plain data in a JSON file: its dialog titles and button labels are fixture
// content, not interface text, and the i18n guard reads .ts files only.
 
const DATA = require('./fixtures.json') as { WIRED: AppDefinition; BROKEN: AppDefinition };

export const WIRED: AppDefinition = deepFreeze(DATA.WIRED);
/** Broken ids: missing, malformed, duplicated; references that follow them. */
export const BROKEN: AppDefinition = deepFreeze(DATA.BROKEN);

export interface Samples {
    BLANK_APP: AppDefinition;
    KITCHEN_SINK: AppDefinition;
    V2_SHOWCASE: AppDefinition;
    V2_RICH: AppDefinition;
    V21_BATCH: AppDefinition;
}

/** Every fixture by name: the web's samples, then WIRED and BROKEN. */
export function allFixtures(): Record<string, AppDefinition> {
    const samples = loadWeb<Samples>('state/sampleDefinitions.js');
    return {
        BLANK_APP: samples.BLANK_APP,
        KITCHEN_SINK: samples.KITCHEN_SINK,
        V2_SHOWCASE: samples.V2_SHOWCASE,
        V2_RICH: samples.V2_RICH,
        V21_BATCH: samples.V21_BATCH,
        WIRED,
        BROKEN,
    };
}

/** A seeded Math.random, so two id-generating runs produce the same ids. */
export function seededRandom(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Run `fn` with Math.random replaced by a fresh seeded generator. */
export function withSeed<T>(seed: number, fn: () => T): T {
    const spy = jest.spyOn(Math, 'random').mockImplementation(seededRandom(seed));
    try {
        return fn();
    } finally {
        spy.mockRestore();
    }
}
