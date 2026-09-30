/**
 * The speaker editor's rules. A swap of two names is a supported edit (the
 * server resolves renames against the ORIGINAL names), so it must not read as
 * a collision; two survivors sharing a name must.
 */

import { buildSpeakerEdit, speakerCollision } from './speakers';
import type { Speaker } from './types';

const SPEAKERS: Speaker[] = [{ id: 'Speaker 1' }, { id: 'Speaker 2' }, { id: 'Tom' }];
const same = { 'Speaker 1': 'Speaker 1', 'Speaker 2': 'Speaker 2', Tom: 'Tom' };

describe('speakerCollision', () => {
    it('allows renames and a swap', () => {
        expect(speakerCollision(SPEAKERS, { ...same, 'Speaker 1': 'Gerard' }, [])).toBeNull();
        expect(speakerCollision(SPEAKERS, { ...same, 'Speaker 2': 'Tom', Tom: 'Speaker 2' }, [])).toBeNull();
    });

    it('names both rows when two survivors would share a name, whatever the case', () => {
        expect(speakerCollision(SPEAKERS, { ...same, 'Speaker 1': 'tom' }, [])).toBe(
            '"Speaker 1" and "Tom" would both become "Tom". Merge them instead, or use different names.',
        );
    });

    it('refuses an empty name', () => {
        expect(speakerCollision(SPEAKERS, { ...same, Tom: '  ' }, [])).toBe('Tom needs a name.');
    });

    it('ignores speakers selected for a merge', () => {
        expect(speakerCollision(SPEAKERS, { ...same, 'Speaker 1': 'Tom' }, ['Speaker 1', 'Tom'])).toBeNull();
    });
});

describe('buildSpeakerEdit', () => {
    it('sends only the renames that change something, trimmed', () => {
        expect(buildSpeakerEdit(SPEAKERS, { ...same, 'Speaker 2': ' Gerard ' }, [], null)).toEqual({
            renames: { 'Speaker 2': 'Gerard' },
            merges: [],
        });
    });

    it('merges the other selected speakers into the chosen one', () => {
        expect(buildSpeakerEdit(SPEAKERS, same, ['Speaker 1', 'Speaker 2', 'Tom'], 'Tom').merges).toEqual([
            { from: ['Speaker 1', 'Speaker 2'], into: 'Tom' },
        ]);
    });

    it('does not merge a single selection', () => {
        expect(buildSpeakerEdit(SPEAKERS, same, ['Tom'], 'Tom').merges).toEqual([]);
    });
});
