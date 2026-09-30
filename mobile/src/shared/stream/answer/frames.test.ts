/**
 * The answer table, frame by frame: what each event the web draws leaves on
 * the live turn. Folded through the direct adapter; the agent adapter spreads
 * the same table (adapters/agent.test.ts covers where the two differ).
 */

import { DIRECT_FRAMES, emptyStreamingTurn, type StreamingTurn } from '../adapters/direct';
import { reduceFrame } from '../chatFrameReducer';

function fold(frames: [string, unknown?][], turn: StreamingTurn = emptyStreamingTurn()): StreamingTurn {
    for (const [event, data] of frames) reduceFrame(DIRECT_FRAMES, turn, { event, data: data ?? {} }, { mark: () => {} });
    return turn;
}

describe('thinking parts', () => {
    it('keeps each part with its own text and times, and the flat text beside them', () => {
        const turn = fold([
            ['thinking_start', { partId: 'p1' }],
            ['thinking', { partId: 'p1', text: 'Let me ' }],
            ['thinking', { text: 'see.' }],
            ['thinking_stop', { partId: 'p1' }],
            ['thinking', { text: 'Then' }],
        ]);
        expect(turn.thinkingParts.map((p) => [p.id, p.text, p.endedAt !== null])).toEqual([
            ['p1', 'Let me see.', true],
            ['auto-1', 'Then', false],
        ]);
        expect(turn.thinking).toBe('Let me see.Then');
        expect(turn.thinkingStartedAt).toEqual(expect.any(Number));
        expect(turn.thinkingEndedAt).toEqual(expect.any(Number));
    });

    it('marks a part the provider redacted', () => {
        const turn = fold([['thinking_start', { partId: 'r', redacted: true }], ['thinking_stop', { partId: 'r' }]]);
        expect(turn.thinkingParts[0]).toMatchObject({ id: 'r', text: '', redacted: true });
    });
});

describe('citations and media', () => {
    it('merges the citations of every round, dropping repeats', () => {
        const turn = fold([
            ['kb_sources', { sources: [{ title: 'A', content: 'one' }] }],
            ['kb_sources', { sources: [{ title: 'A', content: 'one' }, { title: 'B', content: 'two' }] }],
        ]);
        expect(turn.sources.map((s) => s.title)).toEqual(['A', 'B']);
    });

    it('keeps audio, video, a built file and a map, and drops the ones with nothing to open', () => {
        const turn = fold([
            ['audio', { url: '/api/storage/a.mp3', source: 'elevenlabs_tts' }],
            ['audio', {}],
            ['video', { url: '/api/storage/v.mp4', mimeType: 'video/mp4' }],
            ['video', { url: '/api/storage/v.mp4' }],
            ['file', { url: '/api/files/deck.pptx', name: 'Deck.pptx', kind: 'presentation', slideCount: 12 }],
            ['file', { name: 'nothing to open' }],
            ['map_embed', { embedUrl: 'https://maps', title: 'Utrecht', mapsLink: 'https://maps.google.com/?q=Utrecht' }],
        ]);
        expect(turn.audio).toEqual([{ url: '/api/storage/a.mp3', mimeType: 'audio/mpeg', source: 'elevenlabs_tts' }]);
        expect(turn.video).toEqual([{ url: '/api/storage/v.mp4', mimeType: 'video/mp4' }]);
        expect(turn.files).toEqual([expect.objectContaining({ name: 'Deck.pptx', slideCount: 12 })]);
        expect(turn.maps).toEqual([{ embedUrl: 'https://maps', title: 'Utrecht', mapsLink: 'https://maps.google.com/?q=Utrecht' }]);
    });
});

describe('drafts', () => {
    it('stacks each kind, deduplicated on the web’s own keys', () => {
        const mail = { to: 'a@b.nl', subject: 'Hi', body: 'Hello' };
        const turn = fold([
            ['email_draft', mail],
            ['email_draft', { ...mail, cc: 'c@d.nl' }],
            ['calendar_draft', { action: 'create', title: 'Standup', startTime: '2026-09-25T09:00' }],
            ['linkedin_draft', { text: 'Post' }],
            ['linkedin_draft', { text: 'Post' }],
            ['contacts_draft', { action: 'create', firstName: 'Ann' }],
            ['keep_draft', { action: 'create', title: 'Groceries', content: 'milk' }],
        ]);
        expect(turn.drafts.email).toHaveLength(1);
        expect(turn.drafts.calendar).toHaveLength(1);
        // The web stacks every LinkedIn draft it is sent.
        expect(turn.drafts.linkedin).toHaveLength(2);
        expect(turn.drafts.contacts).toHaveLength(1);
        expect(turn.drafts.keep[0]).toMatchObject({ title: 'Groceries' });
    });
});

describe('privacy', () => {
    it('adds up message and attachment tokenisation, on the question and the answer', () => {
        const turn = fold([
            ['pii_tokenized', { entities: [{ label: 'email' }, { label: 'person' }] }],
            ['pii_tokenized', { tokenCount: 3, entities: [{ label: 'iban' }], attachments: [{ filename: 'a.pdf', reason: 'overflow' }] }],
        ]);
        expect(turn.userPrivacy).toMatchObject({ tokenizedCount: 5, categories: ['email', 'person', 'iban'] });
        expect(turn.userPrivacy?.scanWarnings).toEqual([{ filename: 'a.pdf', reason: 'overflow', scannedPages: undefined, totalPages: undefined }]);
        expect(turn.tokenisation).toMatchObject({ source: 'pii', action: 'redact', count: 5, automatic: true });
        expect(turn.tokenisation?.attachments).toHaveLength(1);
    });

    it('keeps the opt-in transparency: what was sent, what came back, and the map', () => {
        const turn = fold([
            ['privacy_payload', { tokenizedPrompt: 'Mail [email_1]', provider: 'gpt' }],
            ['privacy_response_raw', { rawResponse: 'Sent to [email_1]', truncated: true }],
            ['privacy_token_map', { tokenMap: { '[email_1]': 'a@b.nl', junk: 5 } }],
            ['privacy_token_map', { tokenMap: {} }],
        ]);
        expect(turn.tokenisation).toMatchObject({
            tokenizedPrompt: 'Mail [email_1]',
            provider: 'gpt',
            rawResponse: 'Sent to [email_1]',
            rawTruncated: true,
            tokenMap: { '[email_1]': 'a@b.nl' },
        });
    });

    it('records a redact the person chose, and clears the pause either way', () => {
        const asked = fold([['dlp_preview', { decisionId: 'd1', reviewText: 'Call Ann', findings: [{ label: 'person', offset: 5, length: 3 }] }]]);
        expect(asked.dlpDecision).toMatchObject({ decisionId: 'd1', kind: 'chat_text', reviewText: 'Call Ann' });
        expect(asked.dlpDecision?.findings[0]).toMatchObject({ offset: 5, length: 3 });
        const turn = fold([['dlp_resolved', { appliedChoice: 'redact', redactedCount: 2, categories: ['person'], provider: { displayName: 'Mistral' } }]], asked);
        expect(turn.dlpDecision).toBeNull();
        expect(turn.userPrivacy?.dlpRedactedCount).toBe(2);
        expect(turn.tokenisation).toMatchObject({ source: 'dlp', count: 2, provider: 'Mistral' });
    });

    it('holds an attachment review as an attachment', () => {
        const turn = fold([['dlp_attachment_preview', { decisionId: 'd2', filename: 'cv.pdf', reviewText: 'x', findings: [] }]]);
        expect(turn.dlpDecision).toMatchObject({ kind: 'attachment', filename: 'cv.pdf' });
    });

    it('lands only a non-empty rule attribution', () => {
        expect(fold([['rule_attribution', { rules: [] }]]).ruleAttribution).toBeNull();
        expect(fold([['rule_attribution', { rules: ['Never promise dates', { rule: 'Cite the handbook' }] }]]).ruleAttribution).toEqual([
            'Never promise dates',
            'Cite the handbook',
        ]);
    });

    it('names the model, the tier and what Auto picked', () => {
        const turn = fold([['model_selected', { modelId: 'claude', tier: 'fast', fromAuto: true }]]);
        expect([turn.modelId, turn.modelTier, turn.autoSelectedTier]).toEqual(['claude', 'fast', 'fast']);
    });

    it('locks on history_locked', () => {
        const turn = fold([['history_locked', { notebookId: 'n' }]]);
        expect(turn.historyLocked).toBe(true);
        expect(turn.blocked).not.toBeNull();
    });
});
