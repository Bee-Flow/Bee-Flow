/**
 * The web's SSE handlers, against the phone's adapters.
 *
 * agent-hub/src/hooks/useChatEngine/sse/ is the web client's handler for
 * every chat stream event: one handler map per event family in
 * sse/handlers/*.ts, merged in sse/dispatch.ts (sseEvents.ts, once the
 * switch itself, re-exports the dispatcher). Each event key of a family map
 * that dispatch.ts merges must be either
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

const WEB_ENGINE = path.resolve(__dirname, '../../../../agent-hub/src/hooks/useChatEngine');
const readEngine = (rel: string) => fs.readFileSync(path.join(WEB_ENGINE, rel), 'utf8');

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
    memory_used: 'Which memories shaped a reply: a disclosure under the message in the web chat; the phone shows none yet.',
};

/** The family maps dispatch.ts imports from ./handlers/ AND merges into SSE_HANDLERS. */
function webFamilies(): { name: string; file: string }[] {
    const dispatch = readEngine('sse/dispatch.ts');
    const table = dispatch.slice(dispatch.indexOf('export const SSE_HANDLERS = buildHandlerTable(['));
    const merged = table.slice(0, table.indexOf(']);'));
    return [...dispatch.matchAll(/^import \{ ([A-Za-z]+Handlers) \} from '\.\/handlers\/([A-Za-z]+)';$/gm)]
        .map((m) => ({ name: m[1] as string, file: `sse/handlers/${m[2] as string}.ts` }))
        .filter(({ name }) => new RegExp(`\\b${name},`).test(merged));
}

/** The event keys of one `export const xHandlers: SseHandlerMap = { … };`, each a method at the map's indent. */
function familyEvents(file: string, name: string): string[] {
    const source = readEngine(file);
    const start = source.indexOf(`export const ${name}: SseHandlerMap = {`);
    if (start < 0) throw new Error(`${name} is gone from ${file}`);
    const body = source.slice(start, source.indexOf('\n};', start));
    return [...body.matchAll(/^ {4}(?:'([a-z_]+)'|([a-z_]+))\s*(?:\(|:)/gm)].map((m) => (m[1] ?? m[2]) as string);
}

function webEvents(): string[] {
    return [...new Set(webFamilies().flatMap(({ file, name }) => familyEvents(file, name)))];
}

const handledOnPhone = (event: string) => Object.values(SURFACES).some((adapter) => accounts(adapter, event));

describe('the web chat switch and the phone adapters', () => {
    const events = webEvents();

    it('reads enough events for the check to mean something', () => {
        expect(events.length).toBeGreaterThan(50);
    });

    it('reads every family the dispatcher merges, and the old path still dispatches through it', () => {
        const families = webFamilies();
        expect(families.length).toBeGreaterThanOrEqual(11);
        const dispatch = readEngine('sse/dispatch.ts');
        expect(dispatch.match(/^import \{ [A-Za-z]+Handlers \} from '\.\/handlers\//gm)?.length).toBe(families.length);
        expect(dispatch).toContain('SSE_HANDLERS.get(event)?.(ctx, data, ids);');
        expect(readEngine('sseEvents.ts')).toContain("export { dispatchSSEEvent } from './sse/dispatch';");
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
