import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    filterAvailableSteps,
    hasVideoSteps,
    learnMediaBase,
    loadLearnManifest,
    mediaUrl,
    parseManifest,
    resetLearnManifestCache,
    videoForLocale,
} from './learnMedia';
import { stepIsRequired, stepStatusSatisfies, STEP_TYPES } from './stepTypes';

afterEach(() => resetLearnManifestCache());

const manifest = parseManifest({
    version: 3,
    videos: { 'kb-intro': { file: 'kb-intro.abcdef12.mp4', transcript: ['one', 2, ' '] } },
});

describe('parseManifest', () => {
    it('keeps well-formed entries and normalises them', () => {
        expect(manifest).toEqual({
            version: '3',
            videos: { 'kb-intro': { file: 'kb-intro.abcdef12.mp4', captions: {}, transcript: ['one'] } },
        });
    });

    it('drops entries that point outside the pack or at the wrong kind of file', () => {
        const parsed = parseManifest({
            videos: {
                up: { file: '../secret.mp4' },
                abs: { file: '/etc/passwd.mp4' },
                url: { file: 'https://evil.example/x.mp4' },
                dot: { file: '.hidden.mp4' },
                html: { file: 'page.html' },
                'Bad Id': { file: 'ok.mp4' },
                ok: { file: 'clips/ok.mp4', captions: { en: '../x.vtt' }, poster: 'p.png', duration: -1 },
            },
        });
        expect(Object.keys(parsed?.videos || {})).toEqual(['ok']);
        expect(parsed?.videos.ok).toEqual({ file: 'clips/ok.mp4', captions: {}, transcript: [] });
    });

    it('keeps burnedCaptions only when it is literally true', () => {
        const parsed = parseManifest({
            videos: {
                burned: { file: 'b.mp4', burnedCaptions: true, captions: { en: 'b.en.vtt' } },
                plain: { file: 'p.mp4', burnedCaptions: false },
                odd: { file: 'o.mp4', burnedCaptions: 'yes' },
            },
        });
        expect(parsed?.videos.burned).toEqual({ file: 'b.mp4', burnedCaptions: true, captions: { en: 'b.en.vtt' }, transcript: [] });
        expect(parsed?.videos.plain).not.toHaveProperty('burnedCaptions');
        expect(parsed?.videos.odd).not.toHaveProperty('burnedCaptions');
    });

    it('keeps a language variant of a clip, with its own caption track, and drops malformed ones', () => {
        const parsed = parseManifest({
            videos: {
                intro: {
                    file: 'intro.aa.mp4',
                    captions: { en: 'intro.en.aa.vtt' },
                    transcript: ['Hello'],
                    locales: {
                        nl: { file: 'intro.nl.bb.mp4', burnedCaptions: true, captions: { nl: 'intro.nl.bb.vtt', en: 'x.vtt' }, duration: 70, transcript: ['Hallo'] },
                        de: { file: '../evil.mp4' },
                        en: { file: 'twice.mp4' },
                        'nl-BE': { file: 'region.mp4' },
                    },
                },
            },
        });
        expect(parsed?.videos.intro.locales).toEqual({
            nl: { file: 'intro.nl.bb.mp4', burnedCaptions: true, captions: { nl: 'intro.nl.bb.vtt' }, duration: 70, transcript: ['Hallo'] },
        });
        // A clip without any valid variant carries no locales key at all.
        expect(parseManifest({ videos: { a: { file: 'a.mp4', locales: { de: { file: 'x.txt' } } } } })?.videos.a).not.toHaveProperty('locales');
    });

    it('rejects documents that are not manifests', () => {
        for (const raw of [null, 'html', [], {}, { videos: [] }]) expect(parseManifest(raw)).toBeNull();
    });
});

describe('learnMediaBase', () => {
    it('uses an absolute https runtime override', () => {
        expect(learnMediaBase({ learnMedia: { baseUrl: 'https://cdn.example.com/learn/' } })).toBe('https://cdn.example.com/learn');
    });

    it('ignores anything else and falls back to the server path', () => {
        for (const baseUrl of ['http://cdn.example.com', 'javascript:alert(1)', '', 42, '//cdn.example.com']) {
            expect(learnMediaBase({ learnMedia: { baseUrl } })).toMatch(/\/learn-media$/);
        }
        expect(learnMediaBase(null)).toMatch(/\/learn-media$/);
    });

    it('encodes each path segment', () => {
        expect(mediaUrl('/learn-media', 'a b/c.mp4')).toBe('/learn-media/a%20b/c.mp4');
    });
});

describe('loadLearnManifest', () => {
    it('fetches once and caches the result for every caller', async () => {
        const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ videos: {} }) }));
        const [a, b] = await Promise.all([
            loadLearnManifest({ fetchImpl, base: '/m' }),
            loadLearnManifest({ fetchImpl, base: '/m' }),
        ]);
        const c = await loadLearnManifest({ fetchImpl, base: '/m' });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(fetchImpl.mock.calls[0]).toEqual(['/m/manifest.json', expect.objectContaining({ credentials: 'same-origin' })]);
        expect(a).toEqual({ status: 'ready', manifest: { version: '', videos: {} }, base: '/m' });
        expect(b).toBe(a);
        expect(c).toBe(a);
    });

    it('is unavailable on a 404, on HTML, on a network error and on a timeout', async () => {
        const cases = [
            vi.fn(async () => ({ ok: false, json: async () => ({}) })),
            vi.fn(async () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token <'); } })),
            vi.fn(async () => { throw new TypeError('Failed to fetch'); }),
            vi.fn(() => new Promise<never>(() => {})),
        ];
        for (const fetchImpl of cases) {
            resetLearnManifestCache();
            expect(await loadLearnManifest({ fetchImpl, base: '/m', timeoutMs: 20 })).toEqual({ status: 'unavailable' });
        }
    });
});

describe('video steps in a lesson', () => {
    const steps = [
        { id: 's1', type: 'slide' },
        { id: 'v1', type: 'video', videoId: 'kb-intro' },
        { id: 'v2', type: 'video', videoId: 'not-in-pack' },
        { id: 'q1', type: 'quiz' },
    ];

    it('drops videos the pack lacks, and all of them without a manifest', () => {
        expect(hasVideoSteps(steps)).toBe(true);
        expect(hasVideoSteps([{ id: 'x' }])).toBe(false);
        expect(filterAvailableSteps(steps, manifest).map((s) => s.id)).toEqual(['s1', 'v1', 'q1']);
        expect(filterAvailableSteps(steps, null).map((s) => s.id)).toEqual(['s1', 'q1']);
    });

    it('drops a video that failed to play', () => {
        expect(filterAvailableSteps(steps, manifest, new Set(['v1'])).map((s) => s.id)).toEqual(['s1', 'q1']);
    });

    it('never gates the lesson', () => {
        const video = { id: 'v1', type: STEP_TYPES.VIDEO, videoId: 'kb-intro', optional: false };
        expect(stepIsRequired(video)).toBe(false);
        expect(stepStatusSatisfies(video, 'watched')).toBe(true);
        expect(stepStatusSatisfies(video, 'skipped')).toBe(true);
        // Existing kinds are unchanged.
        expect(stepIsRequired({ type: 'quiz' })).toBe(true);
        expect(stepStatusSatisfies({ type: 'slide' }, undefined)).toBe(true);
    });
});

describe('videoForLocale', () => {
    const entry = parseManifest({
        videos: { intro: { file: 'intro.mp4', captions: { en: 'intro.en.vtt' }, transcript: [], locales: { nl: { file: 'intro.nl.mp4', captions: { nl: 'intro.nl.vtt' }, transcript: [] } } } },
    })!.videos.intro;

    it('plays the variant in the language the learner reads the app in', () => {
        expect(videoForLocale(entry, 'nl')).toEqual({ video: entry.locales!.nl, lang: 'nl' });
        expect(videoForLocale(entry, 'nl-BE').lang).toBe('nl');
    });

    it('falls back to the English clip for any other language, or none', () => {
        for (const locale of ['en', 'de', '', null, undefined]) {
            expect(videoForLocale(entry, locale)).toEqual({ video: entry, lang: 'en' });
        }
    });
});
