/**
 * One voice turn's frames, without a microphone: what is shown while it
 * streams, what decides how it ends, and what it commits to the conversation.
 */

import { applyVoiceFrame, commitTurn, startFold, type TurnFold } from './turnFold';

function foldOf(frames: [string, unknown?][]): TurnFold {
    const fold = startFold();
    for (const [event, data] of frames) applyVoiceFrame(fold, event, data ?? {});
    return fold;
}

describe('applyVoiceFrame', () => {
    it('shows the transcript, the streaming reply and the tools as they arrive', () => {
        const fold = foldOf([
            ['transcript', { text: 'What is on today?', language: 'EN' }],
            ['text', { delta: 'You have ' }],
            ['text', { delta: 'two meetings.' }],
            ['tool_use', { id: 't1', name: 'calendar' }],
            ['tool_result', { id: 't1', name: 'calendar', ok: true, summary: '2 events' }],
        ]);
        expect(fold.live).toEqual({
            transcript: 'What is on today?',
            reply: 'You have two meetings.',
            tools: [{ id: 't1', name: 'calendar', status: 'done', summary: '2 events' }],
        });
        expect(fold.dirty).toBe(true);
    });

    it('pins a language only from a real sentence, lower-cased to two letters', () => {
        expect(foldOf([['transcript', { text: 'Ja', language: 'it' }]]).language).toBeNull();
        expect(foldOf([['transcript', { text: 'Wat staat er vandaag?', language: 'NLD' }]]).language).toBe('nl');
    });

    it('marks a failed tool, and names a tool with no id by its name', () => {
        const fold = foldOf([
            ['tool_use', { name: 'search' }],
            ['tool_result', { name: 'search', ok: false }],
        ]);
        expect(fold.live.tools).toEqual([{ id: 'search', name: 'search', status: 'error', summary: undefined }]);
    });

    it("prefers the server's cleaned reply at done, and its transcript", () => {
        const fold = foldOf([
            ['text', { delta: 'raw }' }],
            ['done', { assistantText: 'clean', transcript: 'heard' }],
        ]);
        expect(fold.finalText).toBe('clean');
        expect(fold.live.transcript).toBe('heard');
        expect(foldOf([['text', { delta: 'kept' }], ['done', { assistantText: '  ' }]]).finalText).toBe('kept');
    });

    it('keeps the speech to play, or says why there is none', () => {
        expect(foldOf([['tts', { audioBase64: 'AAA', mimeType: 'audio/mpeg' }]]).tts?.audioBase64).toBe('AAA');
        expect(foldOf([['tts_unavailable', { reason: 'tts_failed' }]]).ttsNotice).toBe(
            'Speaking the reply failed, so here it is as text.',
        );
        expect(foldOf([['tts_unavailable', {}]]).ttsNotice).toBe(
            'No text-to-speech is configured on this server, so replies appear as text.',
        );
    });

    it('records hearing nothing and a failure, which are not the same', () => {
        expect(foldOf([['no_speech']]).heardNothing).toBe(true);
        expect(foldOf([['error', { message: 'STT down' }]]).failed).toBe('STT down');
        expect(foldOf([['error', 'not json']]).failed).toBe('Voice turn failed');
    });

    it('knows the events it ignores, and says so for one it does not know', () => {
        const fold = startFold();
        expect(applyVoiceFrame(fold, 'thinking', { delta: 'x' })).toBe(true);
        expect(applyVoiceFrame(fold, 'llm_done', {})).toBe(true);
        expect(applyVoiceFrame(fold, 'constructor', {})).toBe(false);
        expect(applyVoiceFrame(fold, 'something_new', {})).toBe(false);
        expect(fold.dirty).toBe(false);
    });
});

describe('commitTurn', () => {
    let n = 0;
    const id = () => `m${++n}`;
    beforeEach(() => {
        n = 0;
    });

    it('commits what was heard and what was said, in order, to the messages and the history', () => {
        const fold = foldOf([
            ['transcript', { text: ' hello ' }],
            ['text', { delta: 'hi there' }],
        ]);
        expect(commitTurn(fold, 1000, id)).toEqual({
            messages: [
                { id: 'm1', role: 'user', content: 'hello', at: 1000 },
                { id: 'm2', role: 'assistant', content: 'hi there', tools: undefined, at: 1001 },
            ],
            history: [
                { role: 'user', content: 'hello' },
                { role: 'assistant', content: 'hi there' },
            ],
        });
    });

    it('shows a reply that only ran tools, but adds nothing to the history for it', () => {
        const fold = foldOf([['tool_use', { id: 't', name: 'x' }]]);
        const committed = commitTurn(fold, 5, id);
        expect(committed.messages).toHaveLength(1);
        expect(committed.messages[0]).toMatchObject({ role: 'assistant', content: '', tools: [{ id: 't' }] });
        expect(committed.history).toEqual([]);
    });

    it('commits nothing for a turn that produced nothing', () => {
        expect(commitTurn(startFold(), 5, id)).toEqual({ messages: [], history: [] });
    });
});
