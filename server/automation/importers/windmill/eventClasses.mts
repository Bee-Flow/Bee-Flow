/**
 * Nextcloud event class (what a Windmill native trigger or the old ExApp's
 * CORE:LISTEN_TO_EVENT names) to the Bee Flow `nextcloud` trigger event.
 *
 * EXACT is a server copy of the connector's EVENTS table
 * (nextcloud-connector/src/webhookListeners.js): the classes the connector
 * registers and the event id each one delivers. A test (eventClasses.test.js)
 * reads the connector table and fails when the two drift, the same way
 * automation/deliverableEvents.js is kept in step.
 *
 * APPROXIMATE are classes with no exact counterpart that map onto the nearest
 * delivered event, with a warning: a "before" event becomes its "after"
 * event, a touch becomes a change, moving to the bin becomes a deletion.
 * The Mail event is A5's `mail.new` (targetNames.mts), registered by the
 * connector under Mail's plural `Events` namespace; the singular spelling
 * stays as an approximate alias for an export that names it so.
 */

import { NEW_NEXTCLOUD_EVENTS } from './targetNames.mts';

export const EXACT: Readonly<Record<string, string>> = Object.freeze({
    'OCP\\Files\\Events\\Node\\NodeCreatedEvent': 'file.new',
    'OCP\\Files\\Events\\Node\\NodeWrittenEvent': 'file.changed',
    'OCP\\Files\\Events\\Node\\NodeDeletedEvent': 'file.deleted',
    'OCP\\Files\\Events\\Node\\NodeRenamedEvent': 'file.renamed',
    'OCP\\Files\\Events\\Node\\NodeCopiedEvent': 'file.copied',
    'OCP\\Files\\Events\\Node\\NodeRestoredEvent': 'file.restored',
    'OCP\\SystemTag\\TagAssignedEvent': 'file.tagged',
    'OCP\\SystemTag\\TagUnassignedEvent': 'file.untagged',
    'OCP\\Calendar\\Events\\CalendarObjectCreatedEvent': 'calendar.event.created',
    'OCP\\Calendar\\Events\\CalendarObjectUpdatedEvent': 'calendar.event.changed',
    'OCP\\Calendar\\Events\\CalendarObjectDeletedEvent': 'calendar.event.deleted',
    'OCP\\Calendar\\Events\\CalendarObjectMovedEvent': 'calendar.event.moved',
    'OCA\\Forms\\Events\\FormSubmittedEvent': 'forms.submitted',
    'OCA\\Tables\\Event\\RowAddedEvent': 'tables.row.added',
    'OCA\\Tables\\Event\\RowUpdatedEvent': 'tables.row.updated',
    'OCA\\Tables\\Event\\RowDeletedEvent': 'tables.row.deleted',
    'OCA\\Deck\\Event\\CardCreatedEvent': 'deck.card.created',
    'OCA\\Deck\\Event\\CardUpdatedEvent': 'deck.card.changed',
    'OCA\\Deck\\Event\\CardDeletedEvent': 'deck.card.deleted',
    'OCA\\Mail\\Events\\NewMessageReceivedEvent': NEW_NEXTCLOUD_EVENTS.mailNew,
});

export const APPROXIMATE: Readonly<Record<string, { event: string; note: string }>> = Object.freeze({
    'OCP\\Files\\Events\\Node\\NodeTouchedEvent': { event: 'file.changed', note: 'A touch (timestamp only) has no own trigger; it starts on any change of the file.' },
    'OCP\\Files\\Events\\Node\\BeforeNodeCreatedEvent': { event: 'file.new', note: 'Starts after the file is created, not before.' },
    'OCP\\Files\\Events\\Node\\BeforeNodeWrittenEvent': { event: 'file.changed', note: 'Starts after the file is written, not before.' },
    'OCP\\Files\\Events\\Node\\BeforeNodeDeletedEvent': { event: 'file.deleted', note: 'Starts after the file is deleted, not before.' },
    'OCP\\Files\\Events\\Node\\BeforeNodeRenamedEvent': { event: 'file.renamed', note: 'Starts after the rename, not before.' },
    'OCP\\Files\\Events\\Node\\BeforeNodeCopiedEvent': { event: 'file.copied', note: 'Starts after the copy, not before.' },
    'OCP\\Files\\Events\\Node\\BeforeNodeTouchedEvent': { event: 'file.changed', note: 'Starts after any change of the file.' },
    'OCP\\Calendar\\Events\\CalendarObjectMovedToTrashEvent': { event: 'calendar.event.deleted', note: 'Moving an event to the bin starts the "deleted" trigger.' },
    'OCA\\Mail\\Event\\NewMessageReceivedEvent': { event: NEW_NEXTCLOUD_EVENTS.mailNew, note: 'The Nextcloud Mail trigger reads the sender and attachments itself.' },
});

export type ClassMapping = { event: string; exact: true } | { event: string; exact: false; note: string } | null;

/** The Bee Flow event for a class name; a leading backslash and case of the namespace do not matter. */
export function eventForClass(cls: string): ClassMapping {
    const name = cls.startsWith('\\') ? cls.slice(1) : cls;
    if (EXACT[name]) return { event: EXACT[name], exact: true };
    const approx = APPROXIMATE[name];
    if (approx) return { event: approx.event, exact: false, note: approx.note };
    const lower = name.toLowerCase();
    for (const [k, v] of Object.entries(EXACT)) if (k.toLowerCase() === lower) return { event: v, exact: true };
    return null;
}

/** The event family, which decides how `flow_input.event.*` is re-mapped. */
export function familyOf(event: string): 'file' | 'tag' | 'forms' | 'tables' | 'calendar' | 'deck' | 'mail' | 'other' {
    if (event === 'file.tagged' || event === 'file.untagged') return 'tag';
    if (event.startsWith('file.')) return 'file';
    if (event.startsWith('forms.')) return 'forms';
    if (event.startsWith('tables.')) return 'tables';
    if (event.startsWith('calendar.')) return 'calendar';
    if (event.startsWith('deck.')) return 'deck';
    if (event.startsWith('mail.')) return 'mail';
    return 'other';
}
