/**
 * The speaker editor's rules: when a set of names cannot be saved, and what
 * edit a set of names and a merge selection amount to.
 */

import type { Speaker, SpeakerEdit } from './types';

/**
 * Two surviving speakers must not end up sharing a name. The server refuses
 * this too, but catching it here means the user sees which two rows collide
 * instead of a sentence about it after a round trip. Speakers selected for a
 * merge are exempt: they are about to become one.
 */
export function speakerCollision(
    speakers: readonly Speaker[],
    names: Readonly<Record<string, string>>,
    selected: readonly string[],
): string | null {
    const seen = new Map<string, string>();
    for (const speaker of speakers) {
        if (selected.includes(speaker.id) && selected.length > 1) continue;
        const next = (names[speaker.id] ?? speaker.id).trim();
        if (!next) return `${speaker.id} needs a name.`;
        const clash = seen.get(next.toLowerCase());
        if (clash && clash !== speaker.id) {
            return `"${clash}" and "${speaker.id}" would both become "${next}". Merge them instead, or use different names.`;
        }
        seen.set(next.toLowerCase(), speaker.id);
    }
    return null;
}

/**
 * The renames that actually change something, plus — when `mergeInto` is one
 * of two or more selected speakers — the merge of the others into it.
 */
export function buildSpeakerEdit(
    speakers: readonly Speaker[],
    names: Readonly<Record<string, string>>,
    selected: readonly string[],
    mergeInto: string | null,
): SpeakerEdit {
    const renames: Record<string, string> = {};
    for (const speaker of speakers) {
        const next = (names[speaker.id] ?? speaker.id).trim();
        if (next && next !== speaker.id) renames[speaker.id] = next;
    }
    const merges =
        mergeInto && selected.length > 1 ? [{ from: selected.filter((id) => id !== mergeInto), into: mergeInto }] : [];
    return { renames, merges };
}
