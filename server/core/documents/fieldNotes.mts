/**
 * Notes people leave each other while they fill in a document together: at a
 * field ("the price is still being negotiated, leave it"), or on the document
 * as a whole (`key` empty). They live in the document's settings, next to the
 * values, so they travel with the document and every reader sees the same:
 *
 *   settings.fieldNotes = [{ id, key, userId, text, at }]
 *
 * A note is its writer's: only they take it away. Pure, so the rules have
 * plain tests; the routes and the team chat's tool add the access checks.
 */

export type Settings = Record<string, unknown>;

export interface FieldNote {
    id: string;
    /** The field the note is at; '' for a note on the whole document. */
    key: string;
    userId: string;
    text: string;
    at: string;
}

export const MAX_NOTES = 100;
export const MAX_NOTE = 500;

const isObject = (v: unknown): v is Settings => !!v && typeof v === 'object' && !Array.isArray(v);
const refusal = (message: string, status: number, errorClass: string): Error => Object.assign(new Error(message), { status, errorClass });

/** The notes a document keeps, read defensively, oldest first. */
export function notesOf(settings: unknown): FieldNote[] {
    const raw = isObject(settings) ? settings.fieldNotes : null;
    if (!Array.isArray(raw)) return [];
    return raw.filter((n): n is FieldNote => isObject(n) && typeof n.id === 'string' && typeof n.key === 'string'
        && typeof n.userId === 'string' && typeof n.text === 'string' && typeof n.at === 'string');
}

/** The settings with a new note; refuses an empty note, an unknown field, or one note too many. */
export function addNote(settings: Settings, input: { id: string, key?: string, userId: string, text: string, now: string, knownKeys: string[] }): Settings {
    const text = String(input.text || '').trim().slice(0, MAX_NOTE);
    const key = String(input.key || '');
    if (!text) throw refusal('Write the note first.', 422, 'field_note_empty');
    if (key && !input.knownKeys.includes(key)) throw refusal('That field is not in this document.', 422, 'field_note_unknown_field');
    const notes = notesOf(settings);
    if (notes.length >= MAX_NOTES) throw refusal(`This document already has ${MAX_NOTES} notes. Remove some first.`, 422, 'field_note_limit');
    return { ...settings, fieldNotes: [...notes, { id: input.id, key, userId: input.userId, text, at: input.now }] };
}

/** The settings without a note; only its writer takes it away. `removed` is null when there is no such note. */
export function removeNote(settings: Settings, noteId: string, userId: string): { settings: Settings, removed: FieldNote | null } {
    const notes = notesOf(settings);
    const found = notes.find((n) => n.id === noteId) || null;
    if (!found) return { settings, removed: null };
    if (found.userId !== userId) throw refusal('Only who wrote a note can remove it.', 403, 'field_note_not_yours');
    return { settings: { ...settings, fieldNotes: notes.filter((n) => n.id !== noteId) }, removed: found };
}
