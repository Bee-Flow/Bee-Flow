/** Where a tap on a word in the DLP review lands in the text. */

import { positionedRuns, wordPieces } from './dlpSpans';

it('places each run at its offset in the text', () => {
    const runs = positionedRuns('Mail anna@x.nl now', [{ id: 'f', offset: 5, length: 9 }]);
    expect(runs.map((r) => [r.type, r.value, r.start])).toEqual([
        ['text', 'Mail ', 0],
        ['span', 'anna@x.nl', 5],
        ['text', ' now', 14],
    ]);
});

it('cuts a run into words and gaps, each word at its place in the whole text', () => {
    expect(wordPieces(' about  Jansen', 20)).toEqual([
        { kind: 'gap', text: ' ' },
        { kind: 'word', word: 'about', offset: 21, length: 5 },
        { kind: 'gap', text: '  ' },
        { kind: 'word', word: 'Jansen', offset: 28, length: 6 },
    ]);
});
