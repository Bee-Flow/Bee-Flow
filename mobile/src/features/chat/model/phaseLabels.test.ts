/**
 * The phase labels are the web's: every `chat.phase.*` key the dictionary
 * has, with the dictionary's own English as the fallback.
 */

import { CLIENT_DICT, readDict } from '@/core/i18n/dictionaryText';

import { PHASE_LABELS, phaseText } from './phaseLabels';

const t = (_key: string, fallback: string, params?: Record<string, unknown>) =>
    fallback.replace(/\{(\w+)\}/g, (_m, name: string) => String(params?.[name] ?? ''));

describe('phase labels', () => {
    const dict = readDict(CLIENT_DICT);
    const webKeys = [...dict.keys()].filter((k) => k.startsWith('chat.phase.')).sort();

    it('cover every chat.phase key, in the dictionary’s English', () => {
        expect(Object.values(PHASE_LABELS).map((l) => l.i18nKey).sort()).toEqual(webKeys);
        for (const label of Object.values(PHASE_LABELS)) expect(label.en).toBe(dict.get(label.i18nKey));
    });

    it('name a known stage with its detail, and an unknown one in its own words', () => {
        expect(phaseText('processing_attachments', 'cv.pdf', t as never)).toBe('Reading attachment cv.pdf…');
        expect(phaseText('rerank_hits', null, t as never)).toBe('rerank hits');
        expect(phaseText('rerank_hits', '3/4', t as never)).toBe('rerank hits: 3/4');
    });
});
