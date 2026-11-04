/**
 * The meeting assistant's refusal sentence is shown in the person's language.
 */

import { _reset, setCatalogue } from '@/core/i18n';

import { emptyMeetingTurn, MEETING_FRAMES, type MeetingTurn } from './meeting';
import { reduceFrame } from '../chatFrameReducer';

function fold(frames: [string, unknown?][], turn: MeetingTurn = emptyMeetingTurn()) {
    for (const [event, data] of frames) {
        reduceFrame(MEETING_FRAMES, turn, { event, data: data ?? {} }, { mark: () => {}, onUnhandled: () => {} });
    }
    return { turn };
}

afterEach(() => _reset());

describe('the refusal sentence', () => {
    it('is translated into the active language for either refusal', () => {
        setCatalogue('nl', { 'mobile.recording.chat_blocked': 'Dit antwoord is tegengehouden door de privacyregels van je organisatie.' });
        for (const event of ['dlp_blocked', 'guardrail_blocked']) {
            expect(fold([[event, { reason: 'x' }]]).turn.error).toBe(
                'Dit antwoord is tegengehouden door de privacyregels van je organisatie.',
            );
        }
    });
});
