import { describe, it, expect } from 'vitest';
import { APP_COMPONENT_TYPES, getComponentEntry } from './componentRegistry';

describe('componentRegistry: getComponentEntry with a missing or odd type', () => {
    it('answers null for no type and for an unknown one', () => {
        expect(getComponentEntry(undefined)).toBeNull();
        expect(getComponentEntry(null)).toBeNull();
        expect(getComponentEntry('')).toBeNull();
        expect(getComponentEntry('nope')).toBeNull();
        expect(getComponentEntry('undefined')).toBeNull();
        expect(getComponentEntry('null')).toBeNull();
    });

    it('answers the entry for a known type, by identity', () => {
        expect(getComponentEntry('heading')).toBe(APP_COMPONENT_TYPES.heading);
    });

    it('still finds keys every object has, as the plain lookup did', () => {
        expect(getComponentEntry('constructor')).toBe(Object);
    });
});
