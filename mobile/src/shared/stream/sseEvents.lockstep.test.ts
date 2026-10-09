/**
 * The web's SSE switch, against the phone's adapters.
 *
 * agent-hub/src/hooks/useChatEngine/sseEvents.ts is the web client's handler
 * for every chat stream event. Each `case '<event>'` there must be either
 * accounted for by at least one mobile surface (routed, or IGNORE in its
 * adapter) or listed below with a one-line reason. A new event on the web
 * then fails here until somebody decides what the phone does with it —
 * rather than falling through to `onUnhandled`, which no screen renders.
 *
 * Read as TEXT: Metro cannot import from agent-hub, and a lockstep must not
 * need a bundler to answer which events exist.
 */

import fs from 'node:fs';
import path from 'node:path';

import { AGENT_FRAMES } from './adapters/agent';
import { DIRECT_FRAMES } from './adapters/direct';
import { libraryFrames } from './adapters/library';
import { MEETING_FRAMES } from './adapters/meeting';
import { WEBPAGE_FRAMES } from './adapters/webpage';
import { accounts, type FrameAdapter } from './chatFrameReducer';

const WEB_SWITCH = path.resolve(__dirname, '../../../../agent-hub/src/hooks/useChatEngine/sseEvents.ts');

const SURFACES: Record<string, FrameAdapter<never>> = {
    direct: DIRECT_FRAMES as FrameAdapter<never>,
    agent: AGENT_FRAMES as FrameAdapter<never>,
    library: libraryFrames(() => ({})) as FrameAdapter<never>,
    meeting: MEETING_FRAMES as FrameAdapter<never>,
    webpage: WEBPAGE_FRAMES as FrameAdapter<never>,
};

/** Web events no mobile surface handles, each with the reason. */
const IGNORED: Record<string, string> = {
    test_chat: 'Agent Studio test chat; the phone never opens a test session.',
    browser_session_queued: 'Browser-automation viewport: a desktop side panel.',
    browser_session_start: 'Browser-automation viewport: a desktop side panel.',
    browser_frame: 'Browser-automation viewport: a desktop side panel.',
    browser_action: 'Browser-automation viewport: a desktop side panel.',
    browser_session_end: 'Browser-automation viewport: a desktop side panel.',
    document_suggestions: 'AI suggestions on a document: reviewed in the document editor, which the phone does not have.',
    slides_deck_update: 'Slides builder: no editor on the phone.',
    slides_theme_update: 'Slides builder: no editor on the phone.',
    slides_source_added: 'Slides builder: no editor on the phone.',
    sheet_update: 'Sheet builder: no editor on the phone.',
    sheet_source_added: 'Sheet builder: no editor on the phone.',
    proposal_blocks_update: 'Proposal builder: no editor on the phone.',
};

function webEvents(): string[] {
    const source = fs.readFileSync(WEB_SWITCH, 'utf8');
    return [...new Set([...source.matchAll(/case '([a-z_]+)'/g)].map((m) => m[1] as string))];
}

const handledOnPhone = (event: string) => Object.values(SURFACES).some((adapter) => accounts(adapter, event));

describe('the web chat switch and the phone adapters', () => {
    const events = webEvents();

    it('reads enough events for the check to mean something', () => {
        expect(events.length).toBeGreaterThan(50);
    });

    it('accounts for every web event on some surface, or says why not', () => {
        const unaccounted = events.filter((e) => !handledOnPhone(e) && !(e in IGNORED));
        expect(unaccounted).toEqual([]);
    });

    it('lists no event a surface has since started handling', () => {
        const stale = Object.keys(IGNORED).filter((e) => handledOnPhone(e));
        expect(stale).toEqual([]);
    });

    it('lists only events the web still handles', () => {
        expect(Object.keys(IGNORED).filter((e) => !events.includes(e))).toEqual([]);
    });

    it('gives every ignored event a reason', () => {
        expect(Object.entries(IGNORED).filter(([, reason]) => reason.trim().length < 10)).toEqual([]);
    });
});
