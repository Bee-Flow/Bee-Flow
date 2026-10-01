import { translate } from '@/core/i18n';

import { pickSentence } from './pickSentence';

const t = translate;

describe('pickSentence', () => {
    it.each<[object, number | null | undefined, string]>([
        [{ take: 'all', as: 'text', join: 'lines' }, 12, 'Comes as text: all 12, one per line.'],
        [{ take: 'all', as: 'text', join: 'comma' }, 3, 'Comes as text: all 3, separated by commas.'],
        [{ take: 'all', as: 'text', join: 'bullets' }, null, 'Comes as text: all of them, as a bulleted list.'],
        [{ take: 'all', as: 'list' }, 12, 'Comes as a list of 12.'],
        [{ take: 'all', as: 'list' }, undefined, 'Comes as a list.'],
        [{ take: 'all', as: 'json' }, 2, 'Comes as data: all 2.'],
        [{ take: 'all', as: 'native' }, 2, 'Comes as it is: all 2.'],
        [{ take: 'first', as: 'number' }, 2, 'Only the first of 2.'],
        [{ take: 'first', as: 'number' }, null, 'Only the first.'],
        [{ take: 'last', as: 'text' }, 2, 'Only the last of 2.'],
        [{ take: 'count', as: 'number' }, 4, 'The number of them (4).'],
        [{ take: 'count', as: 'number' }, null, 'The number of them.'],
        [{ take: 'each', as: 'native' }, 4, 'One value per run, for each item.'],
        [{ take: 'one', as: 'list' }, null, 'Comes as a list of 1.'],
        [{ take: 'one', as: 'text' }, null, ''],
    ])('%j with %p', (intent, count, sentence) => {
        expect(pickSentence(t, intent as never, count)).toBe(sentence);
    });
});
