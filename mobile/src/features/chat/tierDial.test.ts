/**
 * The tier model behind the composer's gauge.
 *
 * These pin the split the web's TierSlider makes: depth tiers become slider
 * stops in canonical order, kinds-of-work become pills, and the panel's
 * subtitles are the web's own words — because the whole point of the control
 * is that the two clients draw the same thing.
 */

import { splitTiers, tierDescription, tierLabel } from './tiers';

const SERVER_TIERS = {
    auto: { auto: true },
    fast: { modelId: 'm1' },
    thinking: { modelId: 'm2' },
    writer: { modelId: 'm3' },
    pro: { modelId: 'm4' },
};

describe('splitTiers', () => {
    it('puts depths on the track and kinds of work below it', () => {
        const { stops, others } = splitTiers(SERVER_TIERS);
        // The owner's own tier set: the slider reads Auto / Fast / Think /
        // Deep Thinking, and Write is a pill — exactly the web screenshot.
        expect(stops).toEqual(['auto', 'fast', 'thinking', 'pro']);
        expect(others).toEqual(['writer']);
    });

    it('keeps a custom tier off the depth scale', () => {
        const { stops, others } = splitTiers({ ...SERVER_TIERS, 'custom:legal': { label: 'Legal' } });
        expect(stops).not.toContain('custom:legal');
        expect(others).toContain('custom:legal');
    });
});

describe('the panel copy', () => {
    it('matches the web word for word', () => {
        // agent-hub tierMeta.js — label + desc pairs. "Thinking → Think" and
        // "pro → Deep Thinking" are the renames a key-prettifier gets wrong.
        expect(tierLabel('thinking')).toBe('Think');
        expect(tierDescription('thinking')).toBe('Complex problems');
        expect(tierLabel('pro')).toBe('Deep Thinking');
        expect(tierDescription('pro')).toBe('Advanced reasoning');
        expect(tierDescription('auto')).toBe('Optimal choice');
        expect(tierDescription('fast')).toBe('Quick answers');
        expect(tierLabel('writer')).toBe('Write');
        expect(tierDescription('writer')).toBe('Long-form content');
    });
});
