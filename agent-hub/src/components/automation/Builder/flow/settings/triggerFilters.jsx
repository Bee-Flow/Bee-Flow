// §WS5 — trigger/event filter editors extracted verbatim from SettingsForm.jsx.
// FilterShell is an internal helper.
import React, { useState, useEffect } from 'react';
import useAutomationApi from '../../../../../hooks/useAutomationApi';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { nOf } from '../../../../admin/Studio/KnowledgeStudio/plural';
import { AMBER_NOTE, hintTextClass, inputClass, sectionHeaderClass, FormRow } from './formPrimitives';

export function GmailFilterFields({ filter, setFilter }) {
    return (
        <div className="rounded-md border border-[var(--border-subtle)] p-3 space-y-3">
            <div className={sectionHeaderClass()}>Gmail filter (all optional, AND across keys)</div>
            <FormRow label="From contains">
                <input type="text" value={filter.from || ''} onChange={(e) => setFilter('from', e.target.value || undefined)}
                    placeholder="boss@example.com" className={inputClass()} />
            </FormRow>
            <FormRow label="To contains">
                <input type="text" value={filter.to || ''} onChange={(e) => setFilter('to', e.target.value || undefined)} className={inputClass()} />
            </FormRow>
            <FormRow label="Subject contains">
                <input type="text" value={filter.subjectContains || ''} onChange={(e) => setFilter('subjectContains', e.target.value || undefined)} className={inputClass()} />
            </FormRow>
            <FormRow label="Subject regex" hint="JS regex. Capped at 200 chars; invalid patterns fail closed.">
                <input type="text" value={filter.subjectRegex || ''} onChange={(e) => setFilter('subjectRegex', e.target.value || undefined)} className={inputClass() + ' font-mono'} />
            </FormRow>
            <FormRow label="Has attachment">
                <label className="inline-flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={filter.hasAttachment === true} onChange={(e) => setFilter('hasAttachment', e.target.checked || undefined)} />
                    Only emails with attachments
                </label>
            </FormRow>
            <FormRow label="Exclude self-sent">
                <label className="inline-flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={filter.excludeFromSelf === true} onChange={(e) => setFilter('excludeFromSelf', e.target.checked || undefined)} />
                    Skip emails I sent
                </label>
            </FormRow>
            <FormRow label="Max age (minutes)" hint="Drop messages older than this. Useful so a long-paused poller doesn't flood with backlog on resume.">
                <input
                    type="number"
                    value={filter.maxAgeMinutes ?? ''}
                    min={1}
                    onChange={(e) => setFilter('maxAgeMinutes', e.target.value === '' ? undefined : Number(e.target.value))}
                    className={inputClass()}
                />
            </FormRow>
        </div>
    );
}

// ── Trigger filter sub-forms (one per (provider, event)) ───────────────
//
// All filters reuse FilterShell as chrome and the standard input/textarea
// helpers — keeps the visual language consistent with the Gmail filter
// users already know. Each field's onChange clears its key when the
// input is empty (`undefined`) so the persisted filter object stays
// minimal and the matcher's "if filter.X is set" checks short-circuit.

function FilterShell({ title, children }) {
    return (
        <div className="rounded-md border border-[var(--border-subtle)] p-3 space-y-3">
            <div className={sectionHeaderClass()}>{title}</div>
            {children}
        </div>
    );
}

/** A comma-separated line as the list we persist. */
const splitCsv = (text) => text.split(',').map(s => s.trim()).filter(Boolean);

export function GmailLabelFilterFields({ filter, setFilter }) {
    // The exclude box keeps its OWN text. The stored list is trimmed and
    // blank-free, so re-joining it would swallow the comma the moment it is
    // typed — the write-back is synchronous, the value recomputes without that
    // character, and React re-asserts node.value. A second label could then
    // only be pasted in. Same cure as the form builder's choices box.
    const joinedExcludes = Array.isArray(filter.excludeLabelIds) ? filter.excludeLabelIds.join(',') : '';
    const [excludeText, setExcludeText] = useState(joinedExcludes);
    // Our own echo round-trips to the same list; only an edit from outside
    // (an undo, a different trigger loaded into the same panel) differs.
    if (splitCsv(excludeText).join(',') !== splitCsv(joinedExcludes).join(',')) setExcludeText(joinedExcludes);

    return (
        <FilterShell title="Gmail label.added filter (labelId is required)">
            <FormRow label="Label id" hint="Gmail label ids look like Label_3 or system ids like IMPORTANT / STARRED. Use a gmail_search step once to find the id if needed.">
                <input type="text" value={filter.labelId || ''} onChange={(e) => setFilter('labelId', e.target.value || undefined)}
                    placeholder="Label_3" className={inputClass()} />
            </FormRow>
            <FormRow label="From contains">
                <input type="text" value={filter.from || ''} onChange={(e) => setFilter('from', e.target.value || undefined)} className={inputClass()} />
            </FormRow>
            <FormRow label="Subject contains">
                <input type="text" value={filter.subjectContains || ''} onChange={(e) => setFilter('subjectContains', e.target.value || undefined)} className={inputClass()} />
            </FormRow>
            <FormRow label="Exclude labels (comma-separated)" hint="Drops messages that already carry any of these labels.">
                <input
                    type="text"
                    aria-label="Exclude labels"
                    value={excludeText}
                    onChange={(e) => {
                        setExcludeText(e.target.value);
                        const arr = splitCsv(e.target.value);
                        setFilter('excludeLabelIds', arr.length ? arr : undefined);
                    }}
                    className={inputClass() + ' font-mono'}
                />
            </FormRow>
        </FilterShell>
    );
}

export function CalendarChangedFilterFields({ filter, setFilter }) {
    return (
        <FilterShell title="Calendar event.changed filter (all optional)">
            <FormRow label="Calendar id" hint="Default 'primary'. Use a different calendar id if you've connected secondary calendars.">
                <input type="text" value={filter.calendarId || ''} onChange={(e) => setFilter('calendarId', e.target.value || undefined)}
                    placeholder="primary" className={inputClass() + ' font-mono'} />
            </FormRow>
            <FormRow label="Status">
                <select
                    value={filter.statusEquals || ''}
                    onChange={(e) => setFilter('statusEquals', e.target.value || undefined)}
                    className={inputClass()}
                >
                    <option value="">Any</option>
                    <option value="confirmed">confirmed</option>
                    <option value="cancelled">cancelled</option>
                    <option value="tentative">tentative</option>
                </select>
            </FormRow>
            <FormRow label="Attendee email contains">
                <input type="text" value={filter.attendeeEmailContains || ''} onChange={(e) => setFilter('attendeeEmailContains', e.target.value || undefined)}
                    className={inputClass()} />
            </FormRow>
        </FilterShell>
    );
}

export function CalendarUpcomingFilterFields({ filter, setFilter }) {
    return (
        <FilterShell title="Calendar event.upcoming filter">
            <FormRow label="Lead minutes" hint="Fire this many minutes before the event starts. Default 15.">
                <input
                    type="number"
                    min={1}
                    max={240}
                    value={filter.leadMinutes ?? 15}
                    onChange={(e) => setFilter('leadMinutes', e.target.value === '' ? undefined : Number(e.target.value))}
                    className={inputClass()}
                />
            </FormRow>
            <FormRow label="Calendar id">
                <input type="text" value={filter.calendarId || ''} onChange={(e) => setFilter('calendarId', e.target.value || undefined)}
                    placeholder="primary" className={inputClass() + ' font-mono'} />
            </FormRow>
            <FormRow label="Include all-day events">
                <label className="inline-flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={filter.includeAllDay === true} onChange={(e) => setFilter('includeAllDay', e.target.checked || undefined)} />
                    Yes — fire on all-day events too
                </label>
            </FormRow>
            <FormRow label="Attendee email contains">
                <input type="text" value={filter.attendeeEmailContains || ''} onChange={(e) => setFilter('attendeeEmailContains', e.target.value || undefined)}
                    className={inputClass()} />
            </FormRow>
        </FilterShell>
    );
}

export function DriveFileNewFilterFields({ filter, setFilter }) {
    return (
        <FilterShell title="Drive file.new filter (all optional)">
            <FormRow label="Folder id" hint="Drive folder id. Find via drive_search or by copying from the URL: drive.google.com/drive/folders/<id>.">
                <input type="text" value={filter.folderId || ''} onChange={(e) => setFilter('folderId', e.target.value || undefined)}
                    className={inputClass() + ' font-mono'} />
            </FormRow>
            <FormRow label="MIME type" hint="e.g. application/pdf, image/jpeg, application/vnd.google-apps.document.">
                <input type="text" value={filter.mimeType || ''} onChange={(e) => setFilter('mimeType', e.target.value || undefined)}
                    placeholder="application/pdf" className={inputClass() + ' font-mono'} />
            </FormRow>
            <FormRow label="Name contains">
                <input type="text" value={filter.nameContains || ''} onChange={(e) => setFilter('nameContains', e.target.value || undefined)}
                    className={inputClass()} />
            </FormRow>
            <FormRow label="Exclude my own uploads">
                <label className="inline-flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={filter.excludeOwnUploads === true} onChange={(e) => setFilter('excludeOwnUploads', e.target.checked || undefined)} />
                    Skip files I uploaded
                </label>
            </FormRow>
        </FilterShell>
    );
}

export function NextcloudFileFilterFields({ filter, setFilter }) {
    return (
        <FilterShell title="Nextcloud file filter (all optional)">
            <FormRow label="In folder" hint="Path prefix, e.g. /Invoices. Files outside this folder are skipped.">
                <input type="text" value={filter.inFolder || ''} onChange={(e) => setFilter('inFolder', e.target.value || undefined)}
                    placeholder="/Invoices" className={inputClass() + ' font-mono'} />
            </FormRow>
            <FormRow label="Extension" hint="Without dot, e.g. pdf.">
                <input type="text" value={filter.extension || ''} onChange={(e) => setFilter('extension', e.target.value || undefined)}
                    placeholder="pdf" className={inputClass() + ' font-mono'} />
            </FormRow>
            <FormRow label="Name contains">
                <input type="text" value={filter.nameContains || ''} onChange={(e) => setFilter('nameContains', e.target.value || undefined)}
                    className={inputClass()} />
            </FormRow>
            <FormRow label="Exclude my own actions">
                <label className="inline-flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={filter.excludeOwnUploads === true} onChange={(e) => setFilter('excludeOwnUploads', e.target.checked || undefined)} />
                    Skip files I created/edited
                </label>
            </FormRow>
            <div className="text-[11px] text-[var(--text-tertiary)] leading-snug">
                Manual runs use a <code>null</code> trigger payload — set a sample under Settings → Manual trigger payload to test bindings.
            </div>
        </FilterShell>
    );
}

export function NextcloudShareFilterFields({ filter, setFilter }) {
    return (
        <FilterShell title="Nextcloud share.received filter">
            <FormRow label="Sharer (actor) equals" hint="Nextcloud username (uid) of the person who shared the item.">
                <input type="text" value={filter.actorEquals || ''} onChange={(e) => setFilter('actorEquals', e.target.value || undefined)}
                    className={inputClass() + ' font-mono'} />
            </FormRow>
            <FormRow label="Kind">
                <select
                    value={filter.kindEquals || ''}
                    onChange={(e) => setFilter('kindEquals', e.target.value || undefined)}
                    className={inputClass()}
                >
                    <option value="">Any (file or folder)</option>
                    <option value="file">file</option>
                    <option value="folder">folder</option>
                </select>
            </FormRow>
            <FormRow label="Name contains">
                <input type="text" value={filter.nameContains || ''} onChange={(e) => setFilter('nameContains', e.target.value || undefined)}
                    className={inputClass()} />
            </FormRow>
        </FilterShell>
    );
}

export function NextcloudActivityFilterFields({ filter, setFilter }) {
    return (
        <FilterShell title="Nextcloud activity filter (advanced)">
            <FormRow label="Activity type" hint="Raw activity slug (e.g. file_created, comments, deck). Leave empty to match every type — and prefer file.new / file.changed / share.received as dedicated triggers.">
                <input type="text" value={filter.type || ''} onChange={(e) => setFilter('type', e.target.value || undefined)}
                    placeholder="comments" className={inputClass() + ' font-mono'} />
            </FormRow>
            <FormRow label="Object name contains">
                <input type="text" value={filter.objectNameContains || ''} onChange={(e) => setFilter('objectNameContains', e.target.value || undefined)}
                    className={inputClass()} />
            </FormRow>
            <FormRow label="Actor equals">
                <input type="text" value={filter.actorEquals || ''} onChange={(e) => setFilter('actorEquals', e.target.value || undefined)}
                    className={inputClass() + ' font-mono'} />
            </FormRow>
        </FilterShell>
    );
}

export function NextcloudNotificationFilterFields({ filter, setFilter }) {
    return (
        <FilterShell title="Nextcloud notification filter">
            <FormRow label="App" hint="Source app id (e.g. spreed, files_sharing, dav, updatenotification).">
                <input type="text" value={filter.app || ''} onChange={(e) => setFilter('app', e.target.value || undefined)}
                    placeholder="spreed" className={inputClass() + ' font-mono'} />
            </FormRow>
            <FormRow label="Subject contains">
                <input type="text" value={filter.subjectContains || ''} onChange={(e) => setFilter('subjectContains', e.target.value || undefined)}
                    className={inputClass()} />
            </FormRow>
        </FilterShell>
    );
}

export function SupportTicketResolvedFilterFields({ filter, setFilter }) {
    return (
        <FilterShell title="Support Inbox ticket.resolved filter (all optional)">
            <FormRow label="Inbox id" hint="Restrict to one support inbox. Leave empty to match every inbox.">
                <input type="text" value={filter.inboxId || ''} onChange={(e) => setFilter('inboxId', e.target.value || undefined)}
                    className={inputClass() + ' font-mono'} />
            </FormRow>
            <FormRow label="Category equals" hint="The AI-classified category. Free text — no enum yet.">
                <input type="text" value={filter.categoryEquals || ''} onChange={(e) => setFilter('categoryEquals', e.target.value || undefined)}
                    className={inputClass()} />
            </FormRow>
            <FormRow label="Priority equals">
                <select
                    value={filter.priorityEquals || ''}
                    onChange={(e) => setFilter('priorityEquals', e.target.value || undefined)}
                    className={inputClass()}
                >
                    <option value="">Any</option>
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                    <option value="urgent">urgent</option>
                </select>
            </FormRow>
            <FormRow label="Tag includes" hint="Fires only when the ticket carries this tag.">
                <input type="text" value={filter.tagIncludes || ''} onChange={(e) => setFilter('tagIncludes', e.target.value || undefined)}
                    className={inputClass()} />
            </FormRow>
            <FormRow label="Resolved by">
                <select
                    value={filter.resolvedBy || ''}
                    onChange={(e) => setFilter('resolvedBy', e.target.value || undefined)}
                    className={inputClass()}
                >
                    <option value="">Any</option>
                    <option value="ai">ai</option>
                    <option value="staff">staff</option>
                </select>
            </FormRow>
            <FormRow label="Min messages" hint="Skip tickets with fewer messages than this.">
                <input
                    type="number"
                    min={1}
                    value={filter.minMessages ?? ''}
                    onChange={(e) => setFilter('minMessages', e.target.value === '' ? undefined : Number(e.target.value))}
                    className={inputClass()}
                />
            </FormRow>
            <FormRow label="Require genuine contact" hint="Default on: only real customer conversations fire. Unchecking also matches tickets without verified customer contact.">
                <label className="inline-flex items-center gap-2 text-sm">
                    <input
                        type="checkbox"
                        checked={filter.requireGenuineContact !== false}
                        onChange={(e) => setFilter('requireGenuineContact', e.target.checked ? undefined : false)}
                    />
                    Only genuine customer conversations
                </label>
            </FormRow>
        </FilterShell>
    );
}

// Lookup used by AppEventFields — `<provider>.<event>` → filter sub-form.
export function NextcloudFormsSubmittedFilterFields({ filter, setFilter }) {
    return (
        <FilterShell title="Nextcloud form filter (all optional)">
            <FormRow label="Form ID" hint="Numeric id — leave empty to fire for every form you can see. Find it with the “List forms” action.">
                <input type="number" value={filter.formId ?? ''} onChange={(e) => setFilter('formId', e.target.value === '' ? undefined : Number(e.target.value))}
                    placeholder="51" className={inputClass() + ' font-mono'} />
            </FormRow>
            <FormRow label="Form hash" hint="The token in the form's share link — an alternative to the numeric id.">
                <input type="text" value={filter.formHash || ''} onChange={(e) => setFilter('formHash', e.target.value || undefined)}
                    placeholder="abc123def456" className={inputClass() + ' font-mono'} />
            </FormRow>
            <FormRow label="Title contains">
                <input type="text" value={filter.titleContains || ''} onChange={(e) => setFilter('titleContains', e.target.value || undefined)}
                    className={inputClass()} />
            </FormRow>
            <FormRow label="Submitted by" hint="Nextcloud user id. Anonymous submissions have no user, so this never matches them.">
                <input type="text" value={filter.submittedByEquals || ''} onChange={(e) => setFilter('submittedByEquals', e.target.value || undefined)}
                    className={inputClass() + ' font-mono'} />
            </FormRow>
            <div className="text-[11px] text-[var(--text-tertiary)] leading-snug">
                The answers are not in the trigger payload — follow this with the
                <code> Get form submissions </code> action, bound to
                <code> trigger.output.formId </code> and <code> trigger.output.submissionId</code>.
            </div>
        </FilterShell>
    );
}

export function NextcloudTablesRowFilterFields({ filter, setFilter }) {
    return (
        <FilterShell title="Nextcloud Tables row filter (all optional)">
            <FormRow label="Table ID" hint="Numeric id — find it with the “List tables” action.">
                <input type="number" value={filter.tableId ?? ''} onChange={(e) => setFilter('tableId', e.target.value === '' ? undefined : Number(e.target.value))}
                    placeholder="34" className={inputClass() + ' font-mono'} />
            </FormRow>
            <FormRow label="Column ID" hint="Numeric column id to test a value against — from “List table columns”. The event carries column ids, not titles.">
                <input type="number" value={filter.columnId ?? ''} onChange={(e) => setFilter('columnId', e.target.value === '' ? undefined : Number(e.target.value))}
                    placeholder="13" className={inputClass() + ' font-mono'} />
            </FormRow>
            <FormRow label="Value equals">
                <input type="text" value={filter.valueEquals ?? ''} onChange={(e) => setFilter('valueEquals', e.target.value === '' ? undefined : e.target.value)}
                    placeholder="approved" className={inputClass()} />
            </FormRow>
            <FormRow label="Value contains">
                <input type="text" value={filter.valueContains || ''} onChange={(e) => setFilter('valueContains', e.target.value || undefined)}
                    className={inputClass()} />
            </FormRow>
            <FormRow label="Only when that column changed" hint="Row updates fire on any edit. Tick this to fire only when the column above actually changed value.">
                <label className="inline-flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={filter.changedOnly === true} onChange={(e) => setFilter('changedOnly', e.target.checked || undefined)} />
                    Ignore edits that left this column alone
                </label>
            </FormRow>
            <FormRow label="Changed by" hint="Nextcloud user id.">
                <input type="text" value={filter.actorEquals || ''} onChange={(e) => setFilter('actorEquals', e.target.value || undefined)}
                    className={inputClass() + ' font-mono'} />
            </FormRow>
        </FilterShell>
    );
}

export function NextcloudTagFilterFields({ filter, setFilter }) {
    return (
        <FilterShell title="Nextcloud tag filter (all optional)">
            <FormRow label="Tag ID" hint="Numeric id — from the “List tags” action. Nextcloud's tag event carries ids only, never the tag name.">
                <input type="number" value={filter.tagId ?? ''} onChange={(e) => setFilter('tagId', e.target.value === '' ? undefined : Number(e.target.value))}
                    placeholder="3" className={inputClass() + ' font-mono'} />
            </FormRow>
            <div className="text-[11px] text-[var(--text-tertiary)] leading-snug">
                The event carries no file path either — follow it with a Files action bound to
                <code> trigger.output.fileId </code> if you need the path or contents.
            </div>
        </FilterShell>
    );
}

export function NextcloudCalendarMutationFilterFields({ filter, setFilter }) {
    return (
        <FilterShell title="Nextcloud calendar filter (all optional)">
            <FormRow label="Calendar ID" hint="Numeric id of the calendar. Leave empty for all calendars.">
                <input type="number" value={filter.calendarId ?? ''} onChange={(e) => setFilter('calendarId', e.target.value === '' ? undefined : Number(e.target.value))}
                    className={inputClass() + ' font-mono'} />
            </FormRow>
            <div className="text-[11px] text-[var(--text-tertiary)] leading-snug">
                Nextcloud's calendar webhook carries object metadata only — there is no summary,
                start or end in it, so those cannot be filtered on here. Follow the trigger with
                <code> Get calendar event </code> to read the actual event, or use
                <strong> Calendar event upcoming </strong> if you want to match on the title.
            </div>
        </FilterShell>
    );
}

/**
 * meeting-notes.meeting.processed — de tagregel voor Meeting Notes (M5).
 *
 * DE LEGE TAGFILTER STAAT OP HET SCHERM. Geen tags = ELKE afgeronde
 * vergadernotitie, niet geen enkele; de afweging staat bij de matcher
 * (server/automation/triggerBus/filters.js). Het gevaar van die keuze is niet
 * de regel zelf maar de stilte eromheen: een leeg vak dat "alles" betekent
 * moet dat zéggen, anders ontdekt de auteur het pas aan de runs. Daarom is de
 * zin onder het invoerveld altijd zichtbaar en verandert hij mee — hij is
 * geen waarschuwing bij een fout, hij is de stand van zaken.
 *
 * De tags zelf zijn geen keuzelijst: de woordenschat hangt aan de NOTITIE (GET
 * /api/transcriptions/tags) en niet aan deze trigger, en dat endpoint zit
 * achter de Meeting-Notes-gate. Een vrij tekstveld matcht wat de gebruiker
 * intypt zonder eerst een tweede rechtenvraag te stellen; het scherm zegt
 * daarom expliciet dat er exact en hoofdlettergevoelig vergeleken wordt.
 */
export function MeetingNotesProcessedFilterFields({ filter, setFilter }) {
    const { t } = useTranslation();
    // Eigen tekststaat, net als het Gmail-uitsluitvak: de opgeslagen lijst is
    // getrimd en blanco-vrij, dus terug-joinen slikt de komma op het moment
    // dat je hem typt.
    const stored = Array.isArray(filter.tags)
        ? filter.tags.join(', ')
        : (typeof filter.tags === 'string' ? filter.tags : '');
    const [tagText, setTagText] = useState(stored);
    if (splitCsv(tagText).join(',') !== splitCsv(stored).join(',')) setTagText(stored);
    const tags = splitCsv(tagText);

    // '' = geen mening (alle drie de aanleidingen), 'no' = alleen een eerste
    // notitie, 'yes' = alleen een herverwerking. Weglaten is iets anders dan
    // `false`, dus de sleutel wordt gewist in plaats van op false gezet.
    const reprocessed = filter.reprocessed === true ? 'yes' : (filter.reprocessed === false ? 'no' : '');

    return (
        <FilterShell title={t('meetings.trigger_filter_title', 'Meeting note filter (all optional)')}>
            <FormRow
                label={t('meetings.trigger_tags', 'Tags')}
                htmlFor="meeting-notes-trigger-tags"
                hint={t('meetings.trigger_tags_hint', 'Comma-separated. A note matches when it carries ANY of them. The tags come from the note itself, not from the calendar invite.')}
            >
                <input
                    id="meeting-notes-trigger-tags"
                    type="text"
                    value={tagText}
                    onChange={(e) => {
                        setTagText(e.target.value);
                        const arr = splitCsv(e.target.value);
                        setFilter('tags', arr.length ? arr : undefined);
                    }}
                    placeholder="sales, klant-van-dijk"
                    className={inputClass()}
                />
                {/* Altijd zichtbaar, nooit in de ⓘ-popover: dit is de stand van
                    zaken van de regel, geen achtergrondinformatie. */}
                {tags.length === 0
                    ? (
                        <div className={`${AMBER_NOTE} mt-1 leading-snug`}>
                            {t('meetings.trigger_tags_empty_means_all', 'No tags: this rule runs after EVERY finished meeting note. Name a tag to narrow it.')}
                        </div>
                    )
                    : (
                        <>
                            <div className={`${hintTextClass()} mt-1`}>
                                {nOf(
                                    t, 'meetings.trigger_tags_match', tags.length,
                                    'Runs only for a note carrying this tag.',
                                    'Runs only for a note carrying any of these {count} tags.',
                                )}
                            </div>
                            {/* De tweede stille val: "Sales" matcht "sales" niet.
                                Dat hoort niet achter een klik te zitten. */}
                            <div className={hintTextClass()}>
                                {t('meetings.trigger_tags_exact', 'Matched exactly and case-sensitively, the same way a meeting-tag knowledge source matches.')}
                            </div>
                        </>
                    )}
            </FormRow>
            <FormRow
                label={t('meetings.trigger_reprocessed', 'When to fire')}
                hint={t('meetings.trigger_reprocessed_hint', 'A note becomes readable three ways: the first ingest, a reprocessed recording, and a regenerated summary. The default reacts to all three, because “the summary changed” is usually the point.')}
            >
                <select
                    value={reprocessed}
                    onChange={(e) => {
                        const v = e.target.value;
                        setFilter('reprocessed', v === 'yes' ? true : (v === 'no' ? false : undefined));
                    }}
                    className={inputClass()}
                >
                    <option value="">{t('meetings.trigger_reprocessed_any', 'Every time a note becomes readable')}</option>
                    <option value="no">{t('meetings.trigger_reprocessed_first', 'Only a brand-new note')}</option>
                    <option value="yes">{t('meetings.trigger_reprocessed_again', 'Only a reprocess or a new summary')}</option>
                </select>
            </FormRow>
            {/* Geen belofte van een vervolgstap die niet bestaat: er is
                vandaag GEEN actie die een transcriptionId aanneemt (grep over
                server/integrations levert nul treffers; transcribe_audio
                verwerkt een geüpload bestand, geen bestaande notitie). De zin
                zegt daarom wat de regel wél kan: doorgeven welke vergadering
                klaar is. */}
            <div className={`${hintTextClass()} leading-snug`}>
                {t('meetings.trigger_payload_note', 'The trigger carries the note id, its tags and the organisation — no summary, title or attendees. There is no step that reads a note by id, so a rule acts on WHICH meeting finished: pass the id on and open the note in Bee Flow.')}
            </div>
        </FilterShell>
    );
}

// Unmapped combos render no filter form (the runtime still applies the DSL
// filter via applyDslFilter). Individual exports above stay for tests.
export const FILTER_FORM_BY_KEY = {
    'gmail.mail.new': GmailFilterFields,
    'gmail.label.added': GmailLabelFilterFields,
    'google-calendar.event.changed': CalendarChangedFilterFields,
    'google-calendar.event.upcoming': CalendarUpcomingFilterFields,
    'google-drive.file.new': DriveFileNewFilterFields,
    'nextcloud.file.new': NextcloudFileFilterFields,
    'nextcloud.file.changed': NextcloudFileFilterFields,
    'nextcloud.file.deleted': NextcloudFileFilterFields,
    'nextcloud.file.renamed': NextcloudFileFilterFields,
    'nextcloud.file.tagged': NextcloudTagFilterFields,
    'nextcloud.file.untagged': NextcloudTagFilterFields,
    'nextcloud.forms.submitted': NextcloudFormsSubmittedFilterFields,
    'nextcloud.tables.row.added': NextcloudTablesRowFilterFields,
    'nextcloud.tables.row.updated': NextcloudTablesRowFilterFields,
    'nextcloud.calendar.event.created': NextcloudCalendarMutationFilterFields,
    'nextcloud.calendar.event.changed': NextcloudCalendarMutationFilterFields,
    'nextcloud.share.received': NextcloudShareFilterFields,
    'nextcloud.activity.new': NextcloudActivityFilterFields,
    'nextcloud.notification.new': NextcloudNotificationFilterFields,
    'support.ticket.resolved': SupportTicketResolvedFilterFields,
    'meeting-notes.meeting.processed': MeetingNotesProcessedFilterFields,
};
