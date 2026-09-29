import { describe, it, expect } from 'vitest';
import { attentionPath } from './attentionLink';

/**
 * "Show me" has three answers and the third one is the one that matters: no
 * button at all. A link to /app/studio/apps/null is worse than no link, and a
 * link that is not this app's is not a link this app follows.
 */

const item = (over = {}) => ({
    kind: 'solution',
    deepLink: null,
    finding: { targetId: 'p1' },
    ...over,
});

describe('attentionPath', () => {
    it('follows the server\'s own deep link, as an in-app page', () => {
        expect(attentionPath(item({ kind: 'kb', deepLink: '/app/studio/knowledge/k1' })))
            .toBe('studio/knowledge/k1');
    });

    it('falls back to the registry when the answer carried NO link at all', () => {
        // Not the normal path any more: every one of the six sources sends a
        // deepLink, Solutions included (its source builds its own, because
        // completeness.js's shared map may not). This is the fallback for a
        // row that arrives without one — an older server, or a producer that
        // saw only a definition.
        expect(attentionPath(item())).toBe('studio/solutions/p1');
        expect(attentionPath(item({ kind: 'agent', finding: { targetId: 'a1' } }))).toBe('studio/agents/a1');
    });

    it('encodes an id rather than letting it become path syntax', () => {
        expect(attentionPath(item({ finding: { targetId: 'a/b?c' } }))).toBe('studio/solutions/a%2Fb%3Fc');
    });

    it('refuses a link that does not go into this app', () => {
        // Falls through to the registry, never to the foreign URL.
        expect(attentionPath(item({ deepLink: 'https://example.com/x' }))).toBe('studio/solutions/p1');
        expect(attentionPath(item({ deepLink: '/app/settings', kind: 'nope', finding: {} }))).toBeNull();
    });

    it('has no answer when nothing named a row to open', () => {
        expect(attentionPath(item({ finding: { targetId: null } }))).toBeNull();
        expect(attentionPath(item({ kind: 'notebook' }))).toBeNull();
        expect(attentionPath(null)).toBeNull();
    });
});
