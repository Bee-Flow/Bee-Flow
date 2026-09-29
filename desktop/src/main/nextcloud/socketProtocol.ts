/**
 * The Nextcloud desktop client's socket protocol.
 *
 * Line-based UTF-8. A message is `COMMAND:argument` with a trailing newline,
 * and arguments themselves are colon-separated — which means a path containing
 * a colon (legal on every platform this app supports except Windows) must not
 * be split on every colon it contains. Hence a parser with a split limit
 * rather than `line.split(':')`, and a test that proves it.
 *
 * Only the commands this app uses are modelled. The client speaks more than
 * this; modelling the rest would be guesswork with no caller behind it.
 */

/** A message from the Nextcloud client. */
export interface SocketMessage {
    command: string;
    /** The remainder, split on ':' only as far as the command needs. */
    args: string[];
    /** The whole argument string, unsplit — what a path-bearing reply needs. */
    rest: string;
}

/** Split one line into a message. Returns null for a blank line. */
export function parseLine(line: string): SocketMessage | null {
    const trimmed = line.replace(/[\r\n]+$/, '');
    if (!trimmed.trim()) return null;

    const colon = trimmed.indexOf(':');
    if (colon === -1) return { command: trimmed, args: [], rest: '' };

    const command = trimmed.slice(0, colon);
    const rest = trimmed.slice(colon + 1);
    return { command, args: splitArgs(command, rest), rest };
}

/**
 * How far to split a reply's arguments.
 *
 * `STATUS:OK:/home/tom/Nextcloud/a:b.txt` has two arguments, not three: the
 * state, and then a path that happens to contain a colon. Splitting on every
 * colon truncates that path and the caller silently reports the wrong file.
 */
function splitArgs(command: string, rest: string): string[] {
    const fixedFields = FIXED_FIELD_COUNT[command];
    if (fixedFields === undefined) return [rest];

    const parts: string[] = [];
    let remainder = rest;
    for (let i = 0; i < fixedFields; i += 1) {
        const colon = remainder.indexOf(':');
        if (colon === -1) {
            parts.push(remainder);
            return parts;
        }
        parts.push(remainder.slice(0, colon));
        remainder = remainder.slice(colon + 1);
    }
    parts.push(remainder);
    return parts;
}

/**
 * How many colon-separated fields precede the free-form tail, per command.
 *
 * `STATUS:<state>:<path>` → one fixed field, then the path.
 * `VERSION:<clientVersion>:<protocolVersion>` → the protocol version is the
 * tail, and never contains a colon.
 * `MENU_ITEM:<command>:<flags>:<title>` → two fixed fields, then the title.
 */
const FIXED_FIELD_COUNT: Record<string, number> = {
    STATUS: 1,
    VERSION: 1,
    MENU_ITEM: 2,
    SHARE_STATUS: 1,
};

/** Build a line to send. The client expects no trailing spaces. */
export function formatCommand(command: string, argument?: string): string {
    return argument === undefined || argument === '' ? `${command}:\n` : `${command}:${argument}\n`;
}

/**
 * Feed bytes in, get whole lines out.
 *
 * A socket read is not a message: replies arrive split across reads and
 * batched into one. Everything downstream assumes whole lines, so the
 * buffering lives here and is tested on both shapes.
 */
export class LineBuffer {
    private buffer = '';

    push(chunk: string): SocketMessage[] {
        this.buffer += chunk;
        const messages: SocketMessage[] = [];
        let newline = this.buffer.indexOf('\n');
        while (newline !== -1) {
            const line = this.buffer.slice(0, newline);
            this.buffer = this.buffer.slice(newline + 1);
            const message = parseLine(line);
            if (message) messages.push(message);
            newline = this.buffer.indexOf('\n');
        }
        // A line that never terminates would otherwise grow without bound —
        // this socket is local and trusted, but "trusted" is not "correct".
        if (this.buffer.length > MAX_PENDING_LINE) this.buffer = '';
        return messages;
    }

    reset(): void {
        this.buffer = '';
    }
}

/** Generous for a path plus a status word; far below anything that hurts. */
export const MAX_PENDING_LINE = 64 * 1024;

/**
 * The sync states the client reports, narrowed to the ones worth showing.
 *
 * `NOP` is the client's word for "this path is not in a sync folder", which is
 * a legitimate answer and not an error.
 */
export function normaliseSyncState(raw: string): 'OK' | 'SYNC' | 'ERROR' | 'IGNORE' | 'WARN' | 'NEW' | 'NOP' | 'UNKNOWN' {
    const value = raw.trim().toUpperCase();
    // The client suffixes some states, e.g. OK+SWM for a shared folder.
    const base = value.split('+')[0] ?? '';
    switch (base) {
        case 'OK':
        case 'SYNC':
        case 'ERROR':
        case 'IGNORE':
        case 'WARN':
        case 'NEW':
        case 'NOP':
            return base;
        case 'NONE':
            return 'NOP';
        default:
            return 'UNKNOWN';
    }
}
