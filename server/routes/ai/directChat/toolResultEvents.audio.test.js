/**
 * What a saved audio clip says about where it came from.
 *
 * The chat picks a clip's title from its `source`: a tool name containing
 * 'tts' is speech, 'sfx' is a sound effect, anything else is music
 * (agent-hub/src/components/chat/MessageItem/GeneratedMedia.jsx). So a
 * missing source does not show as "unknown" — it shows as "AI Generated
 * Music", confidently and wrongly. It was missing on every non-streamed tool
 * round, because only the streamed return carried the tool's name.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const emit = require(path.join(process.cwd(), 'routes/ai/directChat/toolResultEvents.js'));
const fn = typeof emit === 'function' ? emit : emit.emitToolResultEvents;

function turnOf() {
    return {
        send: () => {},
        collectedEmailDrafts: [], collectedCalendarDrafts: [],
        generatedAudio: [], generatedFiles: [],
    };
}
const audio = (name) => ({ _toolName: name, _toolResult: { audioUrl: 'u' } });

test('the stored audio names the tool that produced it, streamed or not', () => {
    for (const streamed of [true, false]) {
        const turn = turnOf();
        fn(turn, [audio('elevenlabs_tts')], { streamed });
        assert.deepStrictEqual(turn.generatedAudio, [{ url: 'u', source: 'elevenlabs_tts' }],
            `streamed: ${streamed}`);
    }
});
