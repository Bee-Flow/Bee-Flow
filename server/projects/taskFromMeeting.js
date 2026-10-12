// @typecheck
/**
 * Turning the action items of a meeting note into task suggestions: who an
 * item is for (the note holds a first name, a task needs a member), and what
 * the task says. Pure: the route reads the note and the members and hands
 * them in.
 */

'use strict';

const crypto = require('crypto');

/** What the extractor writes when nobody was named (English and Dutch), and the empty name. */
const UNASSIGNED = new Set(['', 'unassigned', 'niet toegewezen', 'nobody', 'niemand', 'n/a', '-']);

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * The member an action item's name points at, or null when it is empty or
 * not one person: the full name, else, when the note holds only a first name, the one member with that
 * first name. A full name that matches nobody is nobody: "Tom Kooy" is not "Tom Smith".
 *
 * @param {string|null|undefined} name
 * @param {{ id: string, name: string }[]} people
 * @returns {string|null} a user id
 */
function matchAssignee(name, people) {
    const wanted = norm(name);
    if (UNASSIGNED.has(wanted)) return null;
    const full = people.filter((p) => norm(p.name) === wanted);
    if (full.length === 1) return full[0].id;
    if (full.length > 1) return null;
    if (wanted.includes(' ')) return null;
    const first = people.filter((p) => norm(p.name).split(' ')[0] === wanted);
    return first.length === 1 ? first[0].id : null;
}

/**
 * What the action item SAID, as a short stable hash. The extractor's ids are positions (`ai-<n>`) and move
 * when the summary is regenerated; the words are what tell one item from another.
 * @param {unknown} text
 * @returns {string} '' for no text
 */
function itemTextHash(text) {
    const t = norm(text);
    return t ? crypto.createHash('sha256').update(t).digest('hex').slice(0, 16) : '';
}

/** The key a made task is filed under in `created` (store tasksFromMeeting): the id alone when there is no text to pin it. */
function itemKey(itemId, text) {
    const hash = itemTextHash(text);
    return hash ? `${itemId}#${hash}` : itemId;
}

/**
 * The task an action item already became, or null. A task made with the text hash only counts when the
 * item's words are still the same; one made before the hash was kept is found by its id alone.
 * @param {Map<string, string>} created  store tasksFromMeeting
 * @param {string} itemId
 * @param {unknown} text
 * @returns {string|null}
 */
function createdTaskFor(created, itemId, text) {
    return created.get(itemKey(itemId, text)) || created.get(itemId) || null;
}

/** `12:05` or `1:02:03` for a timestamp in seconds, or ''. */
function clock(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '';
    const s = Math.floor(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/**
 * @param {{ id: string, title?: string, actionItems?: any[] }} note
 * @param {{ id: string, name: string }[]} people          the project's members
 * @param {Map<string, string>} created                    store tasksFromMeeting: the tasks the items already became
 */
function suggestionsFromNote(note, people, created) {
    const items = Array.isArray(note.actionItems) ? note.actionItems : [];
    const out = [];
    for (const item of items) {
        const text = typeof item?.text === 'string' ? item.text.trim() : '';
        const itemId = typeof item?.id === 'string' ? item.id : '';
        if (!text || !itemId) continue;
        out.push({
            itemId,
            text,
            assigneeName: typeof item.assignee === 'string' ? item.assignee : '',
            suggestedAssigneeId: matchAssignee(item.assignee, people),
            dueDate: typeof item.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.due) ? item.due : null,
            at: clock(item.timestamp),
            done: item.done === true,
            createdTaskId: createdTaskFor(created, itemId, text),
        });
    }
    return out;
}

module.exports = { matchAssignee, suggestionsFromNote, clock, itemTextHash, itemKey, createdTaskFor };
