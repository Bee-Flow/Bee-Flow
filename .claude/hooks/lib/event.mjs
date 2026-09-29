// The event Claude Code pipes to a hook on stdin, and what the hooks read
// from it.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveRepo } from './repo.mjs';

/** The parsed event, or null when stdin is not JSON (the hook then stays out of the way). */
export function readEvent() {
    try {
        return JSON.parse(readFileSync(0, 'utf8') || '{}');
    } catch {
        return null;
    }
}

/**
 * For an Edit/Write event: the file it touched, made absolute, and that
 * file's checkout. Null when the event names no file or no checkout is found.
 *
 * @param {{ tool_input?: { file_path?: string }, cwd?: string } | null} event
 */
export function editedFile(event) {
    const given = event?.tool_input?.file_path;
    if (!given) return null;
    const file = path.resolve(event.cwd || process.cwd(), given);
    const repo = resolveRepo({ filePath: file, cwd: event.cwd });
    return repo ? { file, repo } : null;
}
