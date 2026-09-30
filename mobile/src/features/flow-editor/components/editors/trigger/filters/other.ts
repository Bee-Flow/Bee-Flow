/**
 * The Support Inbox and Meeting Notes filters — the web's
 * SupportTicketResolvedFilterFields and MeetingNotesProcessedFilterFields.
 *
 * Meeting Notes' empty tag list means EVERY finished note, not none, so the
 * sentence under the tags always says which one it is: a box that means
 * "everything" when empty has to say so.
 */

import { msg, type FieldSpec, type Msg } from '@/features/flow-editor/components/editors/declarative/spec';
import type { FormDraft } from '@/features/flow-editor/formState';

import { ANY, filterNote, filterOf, listFilter, numberFilter, putFilter, raw, selectFilter, splitList, textFilter, tickFilter, type FilterForm } from './fields';

export const SUPPORT_TICKET_RESOLVED: FilterForm = {
    title: msg('mobile.flow.filter.support_title', 'Support Inbox ticket.resolved filter (all optional)'),
    fields: [
        textFilter('inboxId', msg('mobile.flow.filter.inbox_id', 'Inbox id'), {
            hint: msg('mobile.flow.filter.inbox_id_hint', 'Restrict to one support inbox. Leave empty to match every inbox.'),
        }),
        textFilter('categoryEquals', msg('mobile.flow.filter.category_equals', 'Category equals'), {
            hint: msg('mobile.flow.filter.category_equals_hint', 'The AI-classified category. Free text — no enum yet.'),
        }),
        selectFilter('priorityEquals', msg('mobile.flow.filter.priority_equals', 'Priority equals'), [ANY, raw('low'), raw('medium'), raw('high'), raw('urgent')]),
        textFilter('tagIncludes', msg('mobile.flow.filter.tag_includes', 'Tag includes'), {
            hint: msg('mobile.flow.filter.tag_includes_hint', 'Fires only when the ticket carries this tag.'),
        }),
        selectFilter('resolvedBy', msg('mobile.flow.filter.resolved_by', 'Resolved by'), [ANY, raw('ai'), raw('staff')]),
        numberFilter('minMessages', msg('mobile.flow.filter.min_messages', 'Min messages'), {
            min: 1,
            hint: msg('mobile.flow.filter.min_messages_hint', 'Skip tickets with fewer messages than this.'),
        }),
        tickFilter(
            'requireGenuineContact',
            msg('mobile.flow.filter.genuine_contact', 'Require genuine contact'),
            msg('mobile.flow.filter.genuine_contact_box', 'Only genuine customer conversations'),
            true,
        ),
        filterNote(
            'genuineContactHint',
            msg(
                'mobile.flow.filter.genuine_contact_hint',
                'Default on: only real customer conversations fire. Unchecking also matches tickets without verified customer contact.',
            ),
        ),
    ],
};

/** The standing sentence under the tags: every note, or which ones. */
function tagsWords(draft: FormDraft): Msg {
    const n = splitList(filterOf(draft).tags).length;
    if (n === 0) return msg('meetings.trigger_tags_empty_means_all', 'No tags: this rule runs after EVERY finished meeting note. Name a tag to narrow it.');
    return n === 1
        ? msg('meetings.trigger_tags_match', 'Runs only for a note carrying this tag.')
        : msg('meetings.trigger_tags_match_plural', 'Runs only for a note carrying any of these {count} tags.', { count: n });
}

/** '' = all three occasions, 'no' = only a first note, 'yes' = only a reprocess — never `false` by accident. */
const REPROCESSED: FieldSpec = {
    ...selectFilter('reprocessed', msg('meetings.trigger_reprocessed', 'When to fire'), [
        { value: '', label: msg('meetings.trigger_reprocessed_any', 'Every time a note becomes readable') },
        { value: 'no', label: msg('meetings.trigger_reprocessed_first', 'Only a brand-new note') },
        { value: 'yes', label: msg('meetings.trigger_reprocessed_again', 'Only a reprocess or a new summary') },
    ]),
    hint: msg(
        'meetings.trigger_reprocessed_hint',
        'A note becomes readable three ways: the first ingest, a reprocessed recording, and a regenerated summary. The default reacts to all three, because “the summary changed” is usually the point.',
    ),
    read: (draft) => {
        const v = filterOf(draft).reprocessed;
        return v === true ? 'yes' : v === false ? 'no' : '';
    },
    write: (v, draft) => putFilter(draft, 'reprocessed', v === 'yes' ? true : v === 'no' ? false : undefined),
};

export const MEETING_NOTES_PROCESSED: FilterForm = {
    title: msg('meetings.trigger_filter_title', 'Meeting note filter (all optional)'),
    fields: [
        listFilter('tags', msg('meetings.trigger_tags', 'Tags'), {
            example: 'sales',
            hint: msg(
                'mobile.flow.filter.meeting_tags_hint',
                'A note matches when it carries ANY of them. The tags come from the note itself, not from the calendar invite.',
            ),
        }),
        { kind: 'note', id: 'tagsState', hint: tagsWords, tone: 'info' },
        {
            kind: 'note',
            id: 'tagsExact',
            hint: msg('meetings.trigger_tags_exact', 'Matched exactly and case-sensitively, the same way a meeting-tag knowledge source matches.'),
            visibleWhen: (draft) => splitList(filterOf(draft).tags).length > 0,
        },
        REPROCESSED,
        filterNote(
            'payloadNote',
            msg(
                'meetings.trigger_payload_note',
                'The trigger carries the note id, its tags and the organisation — no summary, title or attendees. There is no step that reads a note by id, so a rule acts on WHICH meeting finished: pass the id on and open the note in Bee Flow.',
            ),
        ),
    ],
};
