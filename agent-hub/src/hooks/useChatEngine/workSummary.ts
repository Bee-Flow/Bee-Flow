import type { ChatMessage } from './types';
import { describeChatTool, resultFor, visibleToolHistory } from '../../components/chat/MessageItem/chatToolCallDisplay';
import type { TranslateFn } from '../useTranslation';

/** What kind of thing a turn produced, in the words the summary uses. */
export type WorkItemKind = 'webpage' | 'document' | 'notebook';

/** The one work item a turn is credited with, tracked while it streams. */
export interface WorkItem {
    kind?: WorkItemKind;
    title?: string | null;
}

// SSE events that carry a concrete work item, mapped to the user-facing kind
// used by the interrupted/error success summaries (BFSF-221). 'notebook' is
// the agent workspace panel (workspace_update), which the server persists
// BEFORE emitting the event.
export const WORK_EVENT_KINDS: Record<string, WorkItemKind> = {
    webpage_doc_update: 'webpage',
    document_update: 'document',
    webpage_extra_update: 'webpage',
    notebook_doc_update: 'document',
    slides_deck_update: 'document',
    sheet_update: 'document',
    workspace_update: 'notebook',
};

/**
 * First markdown heading in `md` (trimmed, max 80 chars), or null. Used to
 * derive a title for workspace_update payloads, which carry no explicit title.
 */
export function extractMdHeading(md: string | null | undefined): string | null {
    if (!md) return null;
    const m = /^#{1,6}\s+(.+)$/m.exec(md);
    return m ? m[1].trim().slice(0, 80) : null;
}

/**
 * One-line "what was created" summary for a tracked work item ({ kind, title }),
 * or null when nothing was tracked. `t` is the translation function.
 */
export function summarizeWorkItem(t: TranslateFn, wi: WorkItem | null | undefined): string | null {
    if (!wi?.kind) return null;
    const key = wi.title ? `chat.work_summary.${wi.kind}` : `chat.work_summary.${wi.kind}_untitled`;
    return t(key, wi.title ? { title: wi.title } : undefined);
}

/** The tools a turn finished before it failed, as the activity card names them. */
export interface CompletedTools {
    /** One label per tool, with a "×n" suffix when it ran more than once. */
    labels: string[];
    /** How many calls finished, repeats included. */
    count: number;
}

/**
 * Results that the activity card does not read as a failure, although the
 * action never happened. The server reports them as ordinary tool results: a
 * call held for the user's approval or declined by them ("Waiting for the user
 * to approve 'x'. It has not run."), a call refused or blocked before it was
 * dispatched ("[Tool 'x' was not called: ...]", "[Web search blocked ...]",
 * "[Notebook write skipped ...]"), a tool that threw ("[Tool 'x' failed:
 * ...]"), and a draft that waits for the user's approval before anything is
 * sent (`_action: 'email_draft'` and its siblings). A redacted output
 * ("[Tool output redacted ...]") did run.
 */
const NOT_DONE_TEXT = /^\s*(?:\[(?:Tool (?!output redacted)|Web search blocked|Notebook write skipped)|(?:Still waiting|Waiting) for the user to approve\b|The user declined\b)/;

function didNotHappen(result: unknown, preview: unknown): boolean {
    if (result && typeof result === 'object' && !Array.isArray(result)) {
        const action = (result as { _action?: unknown })._action;
        return typeof action === 'string' && action.endsWith('_draft');
    }
    // NOT_DONE_TEXT is linear: anchored, and its one repeat (\s*) is followed
    // only by literals that start with a non-space, so no nested backtracking.
    const text = typeof result === 'string' ? result : (typeof preview === 'string' ? preview : ''); // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos
    return NOT_DONE_TEXT.test(text);
}

/**
 * The tool calls of this turn that finished without an error result. A turn
 * that fails AFTER these ran has still done them: a ticket that was created
 * stays created whatever broke after it, and a bare "Failed to send" invites
 * the retry that files it twice (BFSF-349). Rows still running when the turn
 * ended, results that read as a failure (an `{ error }`, a guard refusal), and
 * calls that never ran (held for approval, declined, refused, a draft) do not
 * count; the labels and the test for failure are the activity card's.
 */
export function completedTools(msg: ChatMessage): CompletedTools {
    const entries: Array<Parameters<typeof describeChatTool>[0]> = visibleToolHistory(msg);
    const perLabel = new Map<string, number>();
    let count = 0;
    entries.forEach((entry, i) => {
        const result = resultFor(msg, i);
        const row = describeChatTool(entry, { result });
        if (row.status !== 'done' || didNotHappen(result, entry?.resultPreview)) return;
        perLabel.set(row.title, (perLabel.get(row.title) || 0) + 1);
        count += 1;
    });
    const labels = [...perLabel].map(([title, n]) => (n > 1 ? `${title} ×${n}` : title));
    return { labels, count };
}
