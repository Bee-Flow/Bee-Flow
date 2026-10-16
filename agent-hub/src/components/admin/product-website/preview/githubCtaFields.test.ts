import { describe, expect, it } from 'vitest';
import { githubCtaFields } from './githubCtaFields';

describe('githubCtaFields', () => {
    it('gives a plain link button no github fields', () => {
        expect(githubCtaFields({ repoUrl: 'https://github.com/example/repo' })).toEqual({});
    });

    it('forwards only the allow-listed fields of a github button', () => {
        const fields = githubCtaFields({
            kind: 'github', repoUrl: 'https://github.com/example/repo', starsFallback: 3, starsText: 'stars', newTabText: 'new tab', other: 1,
        } as Parameters<typeof githubCtaFields>[0]);
        expect(fields).toEqual({ kind: 'github', repoUrl: 'https://github.com/example/repo', starsFallback: 3, starsText: 'stars', newTabText: 'new tab' });
    });

    it('drops values of the wrong type', () => {
        expect(githubCtaFields({ kind: 'github', repoUrl: 5, starsFallback: Number.NaN })).toEqual({ kind: 'github' });
    });
});
