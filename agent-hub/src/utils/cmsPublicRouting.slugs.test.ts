import { describe, expect, it } from 'vitest';
import { LOCALE_PREFIXES, slugIssues } from './cmsPublicRouting';

describe('slugIssues and locale prefixes', () => {
    it('blocks a slug that a language prefix would shadow', () => {
        for (const code of LOCALE_PREFIXES) {
            const issue = slugIssues(code);
            expect(issue?.kind).toBe('reserved');
            expect(issue?.blocking).toBe(true);
        }
    });
});
