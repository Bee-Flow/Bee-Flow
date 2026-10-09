// §WS5 — trigger/event filter editors extracted verbatim from SettingsForm.jsx.
// FilterShell is an internal helper.
import React, { useState, useEffect } from 'react';
import useAutomationApi from '../../../../../hooks/useAutomationApi';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { nOf } from '../../../../admin/Studio/KnowledgeStudio/plural';
import { AMBER_NOTE, hintTextClass, inputClass, sectionHeaderClass, FormRow } from './formPrimitives';

export function GmailFilterFields({ filter, setFilter }) {
    const { t } = useTranslation();
    return (
        <div className="rounded-md border border-[var(--border-subtle)] p-3 space-y-3">
            <div className={sectionHeaderClass()}>{t('automations.trigger_filters.gmail_filter_all_optional_and_across', 'Gmail filter (all optional, AND across keys)')}</div>
            <FormRow label={t('automations.trigger_filters.from_contains', 'From contains')}>
                <input type="text" value={filter.from || ''} onChange={(e) => setFilter('from', e.target.value || undefined)}
                    placeholder="boss@example.com" className={inputClass()} />
            </FormRow>
            <FormRow label={t('automations.trigger_filters.to_contains', 'To contains')}>
                <input type="text" value={filter.to || ''} onChange={(e) => setFilter('to', e.target.value || undefined)} className={inputClass()} />
            </FormRow>
            <FormRow label={t('automations.trigger_filters.subject_contains', 'Subject contains')}>
                <input type="text" value={filter.subjectContains || ''} onChange={(e) => setFilter('subjectContains', e.target.value || undefined)} className={inputClass()} />
            </FormRow>
            <FormRow label={t('automations.trigger_filters.subject_regex', 'Subject regex')} hint={t('automations.trigger_filters.js_regex_capped_at_200_chars', 'JS regex. Capped at 200 chars; invalid patterns fail closed.')}>
                <input type="text" value={filter.subjectRegex || ''} onChange={(e) => setFilter('subjectRegex', e.target.value || undefined)} className={inputClass() + ' font-mono'} />
            </FormRow>
            <FormRow label={t('automations.trigger_filters.has_attachment', 'Has attachment')}>
                <label className="inline-flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={filter.hasAttachment === true} onChange={(e) => setFilter('hasAttachment', e.target.checked || undefined)} />
                    {t('automations.trigger_filters.only_emails_with_attachments', 'Only emails with attachments')}
                </label>
            </FormRow>
            <FormRow label={t('automations.trigger_filters.exclude_self_sent', 'Exclude self-sent')}>
                <label className="inline-flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={filter.excludeFromSelf === true} onChange={(e) => setFilter('excludeFromSelf', e.target.checked || undefined)} />
                    {t('automations.trigger_filters.skip_emails_i_sent', 'Skip emails I sent')}
                </label>
            </FormRow>
            <FormRow label={t('automations.trigger_filters.max_age_minutes', 'Max age (minutes)')} hint={t('automations.trigger_filters.drop_messages_older_than_this_useful', 'Drop messages older than this. Useful so a long-paused poller doesn\'t flood with backlog on resume.')}>
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
    const { t } = useTranslation();
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
        <FilterShell title={t('automations.trigger_filters.gmail_label_added_filter_label_id', 'Gmail label.added filter (labelId is required)')}>
            <FormRow label={t('automations.trigger_filters.label_id', 'Label id')} hint={t('automations.trigger_filters.gmail_label_ids_look_like_label', 'Gmail label ids look like Label_3 or system ids like IMPORTANT / STARRED. Use a gmail_search step once to find the id if needed.')}>
                <input type="text" value={filter.labelId || ''} onChange={(e) => setFilter('labelId', e.target.value || undefined)}
                    placeholder="Label_3" className={inputClass()} />
            </FormRow>
            <FormRow label={t('automations.trigger_filters.from_contains', 'From contains')}>
                <input type="text" value={filter.from || ''} onChange={(e) => setFilter('from', e.target.value || undefined)} className={inputClass()} />
            </FormRow>
            <FormRow label={t('automations.trigger_filters.subject_contains', 'Subject contains')}>
                <input type="text" value={filter.subjectContains || ''} onChange={(e) => setFilter('subjectContains', e.target.value || undefined)} className={inputClass()} />
            </FormRow>
            <FormRow label={t('automations.trigger_filters.exclude_labels_comma_separated', 'Exclude labels (comma-separated)')} hint={t('automations.trigger_filters.drops_messages_that_already_carry_any', 'Drops messages that already carry any of these labels.')}>
                <input
                    type="text"
                    aria-label={t('automations.trigger_filters.exclude_labels', 'Exclude labels')}
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
    const { t } = useTranslation();
    return (
        <FilterShell title={t('automations.trigger_filters.calendar_event_changed_filter_all_optional', 'Calendar event.changed filter (all optional)')}>
            <FormRow label={t('automations.trigger_filters.calendar_id', 'Calendar id')} hint={t('automations.trigger_filters.default_primary_use_a_different_calendar', 'Default \'primary\'. Use a different calendar id if you\'ve connected secondary calendars.')}>
                <input type="text" value={filter.calendarId || ''} onChange={(e) => setFilter('calendarId', e.target.value || undefined)}
                    placeholder={t('automations.trigger_filters.primary', 'primary')} className={inputClass() + ' font-mono'} />
            </FormRow>
            <FormRow label={t('automations.trigger_filters.status', 'Status')}>
                <select
                    value={filter.statusEquals || ''}
                    onChange={(e) => setFilter('statusEquals', e.target.value || undefined)}
                    className={inputClass()}
                >
                    <option value="">{t('automations.trigger_filters.any', 'Any')}</option>
                    <option value="confirmed">{t('automations.trigger_filters.confirmed', 'confirmed')}</option>
                    <option value="cancelled">{t('automations.trigger_filters.cancelled', 'cancelled')}</option>
                    <option value="tentative">{t('automations.trigger_filters.tentative', 'tentative')}</option>
                </select>
            </FormRow>
            <FormRow label={t('automations.trigger_filters.attendee_email_contains', 'Attendee email contains')}>
                <input type="text" value={filter.attendeeEmailContains || ''} onChange={(e) => setFilter('attendeeEmailContains', e.target.value || undefined)}
                    className={inputClass()} />
            </FormRow>
        </FilterShell>
    );
}

export function CalendarUpcomingFilterFields({ filter, setFilter }) {
    const { t } = useTranslation();
    return (
        <FilterShell title={t('automations.trigger_filters.calendar_event_upcoming_filter', 'Calendar event.upcoming filter')}>
            <FormRow label={t('automations.trigger_filters.lead_minutes', 'Lead minutes')} hint={t('automations.trigger_filters.fire_this_many_minutes_before_the', 'Fire this many minutes before the event starts. Default 15.')}>
                <input
                    type="number"
                    min={1}
                    max={240}
                    value={filter.leadMinutes ?? 15}
                    onChange={(e) => setFilter('leadMinutes', e.target.value === '' ? undefined : Number(e.target.value))}
                    className={inputClass()}
                />
            </FormRow>
            <FormRow label={t('automations.trigger_filters.calendar_id', 'Calendar id')}>
                <input type="text" value={filter.calendarId || ''} onChange={(e) => setFilter('calendarId', e.target.value || undefined)}
                    placeholder={t('automations.trigger_filters.primary', 'primary')} className={inputClass() + ' font-mono'} />
            </FormRow>
            <FormRow label={t('automations.trigger_filters.include_all_day_events', 'Include all-day events')}>
                <label className="inline-flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={filter.includeAllDay === true} onChange={(e) => setFilter('includeAllDay', e.target.checked || undefined)} />
                    {t('automations.trigger_filters.yes_fire_on_all_day_events', 'Yes — fire on all-day events too')}
                </label>
            </FormRow>
            <FormRow label={t('automations.trigger_filters.attendee_email_contains', 'Attendee email contains')}>
                <input type="text" value={filter.attendeeEmailContains || ''} onChange={(e) => setFilter('attendeeEmailContains', e.target.value || undefined)}
                    className={inputClass()} />
            </FormRow>
        </FilterShell>
    );
}

/**
 * google-sheets.spreadsheet.changed (BFSF-480) — the filter keys the
 * declaration's `configFields` describes. spreadsheetId is the switch that
 * matters: set, the trigger polls that sheet's CONTENTS and diffs row by row
 * (the declaration's contentWatch variant); empty, it watches the edit time
 * of every spreadsheet you can reach. The hint says so in the field, because
 * the two modes read identically otherwise.
 */
export function SheetsChangedFilterFields({ filter, setFilter }) {
    const { t } = useTranslation();
    return (
        <FilterShell title={t('automations.trigger_filters.google_sheets_filter_all_optional', 'Google Sheets filter (all optional)')}>
            <FormRow label={t('automations.trigger_filters.spreadsheet_id', 'Spreadsheet ID')} hint={t('automations.trigger_filters.from_the_sheet_url_docs_google', 'From the sheet URL: docs.google.com/spreadsheets/d/<id>/edit. Set this to watch the sheet\'s contents row by row; leave empty to fire whenever any of your spreadsheets is edited.')}>
                <input type="text" aria-label={t('automations.trigger_filters.spreadsheet_id', 'Spreadsheet ID')} value={filter.spreadsheetId || ''} onChange={(e) => setFilter('spreadsheetId', e.target.value || undefined)}
                    placeholder={t('automations.trigger_filters.1_ab_cde_fg_hi_jk', '1AbCDeFgHiJkLmNoPqRsTuV')} className={inputClass() + ' font-mono'} />
            </FormRow>
            <FormRow label={t('automations.trigger_filters.sheet_tab', 'Sheet / tab')} hint={t('automations.trigger_filters.tab_name_e_g_budget_only', 'Tab name, e.g. Budget. Only with a spreadsheet picked; default is the first tab.')}>
                <input type="text" aria-label={t('automations.trigger_filters.sheet_tab', 'Sheet / tab')} value={filter.sheet || ''} onChange={(e) => setFilter('sheet', e.target.value || undefined)}
                    placeholder={t('automations.trigger_filters.budget', 'Budget')} className={inputClass()} />
            </FormRow>
            <FormRow label={t('automations.trigger_filters.range', 'Range')} hint={t('automations.trigger_filters.a1_notation_without_the_tab_name', 'A1 notation without the tab name, e.g. A1:D100, or C:C to watch one column. Default: the whole tab.')}>
                <input type="text" aria-label={t('automations.trigger_filters.range', 'Range')} value={filter.range || ''} onChange={(e) => setFilter('range', e.target.value || undefined)}
                    placeholder="A1:D100" className={inputClass() + ' font-mono'} />
            </FormRow>
            {filter.spreadsheetId && (
                <div className="text-[11px] text-[var(--text-tertiary)] leading-snug">
                    {t('automations.trigger_filters.a_changed_row_fires_with', 'A changed row fires with')} <code>row</code> {t('automations.trigger_filters.its_values', '(its values),')} <code>rowIndex</code>{t('automations.trigger_filters.and_the_previous_value_under', ', and the previous value under')} <code>previous</code>{t('automations.trigger_filters.row_numbers_are_positions_inserting_a', '. Row numbers are positions — inserting a row at the top reads as edits to the rows below it.')}
                </div>
            )}
        </FilterShell>
    );
}

export function DriveFileNewFilterFields({ filter, setFilter }) {
    const { t } = useTranslation();
    return (
        <FilterShell title={t('automations.trigger_filters.drive_file_new_filter_all_optional', 'Drive file.new filter (all optional)')}>
            <FormRow label={t('automations.trigger_filters.folder_id', 'Folder id')} hint={t('automations.trigger_filters.drive_folder_id_find_via_drive', 'Drive folder id. Find via drive_search or by copying from the URL: drive.google.com/drive/folders/<id>.')}>
                <input type="text" value={filter.folderId || ''} onChange={(e) => setFilter('folderId', e.target.value || undefined)}
                    className={inputClass() + ' font-mono'} />
            </FormRow>
            <FormRow label={t('automations.trigger_filters.mime_type', 'MIME type')} hint={t('automations.trigger_filters.e_g_application_pdf_image_jpeg', 'e.g. application/pdf, image/jpeg, application/vnd.google-apps.document.')}>
                <input type="text" value={filter.mimeType || ''} onChange={(e) => setFilter('mimeType', e.target.value || undefined)}
                    placeholder="application/pdf" className={inputClass() + ' font-mono'} />
            </FormRow>
            <FormRow label={t('automations.trigger_filters.name_contains', 'Name contains')}>
                <input type="text" value={filter.nameContains || ''} onChange={(e) => setFilter('nameContains', e.target.value || undefined)}
                    className={inputClass()} />
            </FormRow>
            <FormRow label={t('automations.trigger_filters.exclude_my_own_uploads', 'Exclude my own uploads')}>
                <label className="inline-flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={filter.excludeOwnUploads === true} onChange={(e) => setFilter('excludeOwnUploads', e.target.checked || undefined)} />
                    {t('automations.trigger_filters.skip_files_i_uploaded', 'Skip files I uploaded')}
                </label>
            </FormRow>
        </FilterShell>
    );
}

export function NextcloudFileFilterFields({ filter, setFilter }) {
    const { t } = useTranslation();
    return (
        <FilterShell title={t('automations.trigger_filters.nextcloud_file_filter_all_optional', 'Nextcloud file filter (all optional)')}>
            <FormRow label={t('automations.trigger_filters.in_folder', 'In folder')} hint={t('automations.trigger_filters.path_prefix_e_g_invoices_files', 'Path prefix, e.g. /Invoices. Files outside this folder are skipped.')}>
                <input type="text" value={filter.inFolder || ''} onChange={(e) => setFilter('inFolder', e.target.value || undefined)}
                    placeholder="/Invoices" className={inputClass() + ' font-mono'} />
            </FormRow>
            <FormRow label={t('automations.trigger_filters.extension', 'Extension')} hint={t('automations.trigger_filters.without_dot_e_g_pdf', 'Without dot, e.g. pdf.')}>
                <input type="text" value={filter.extension || ''} onChange={(e) => setFilter('extension', e.target.value || undefined)}
                    placeholder={t('automations.trigger_filters.pdf', 'pdf')} className={inputClass() + ' font-mono'} />
            </FormRow>
            <FormRow label={t('automations.trigger_filters.name_contains', 'Name contains')}>
                <input type="text" value={filter.nameContains || ''} onChange={(e) => setFilter('nameContains', e.target.value || undefined)}
                    className={inputClass()} />
            </FormRow>
            <FormRow label={t('automations.trigger_filters.exclude_my_own_actions', 'Exclude my own actions')}>
                <label className="inline-flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={filter.excludeOwnUploads === true} onChange={(e) => setFilter('excludeOwnUploads', e.target.checked || undefined)} />
                    {t('automations.trigger_filters.skip_files_i_created_edited', 'Skip files I created/edited')}
                </label>
            </FormRow>
            <div className="text-[11px] text-[var(--text-tertiary)] leading-snug">
                {t('automations.trigger_filters.manual_runs_use_a', 'Manual runs use a')} <code>null</code> {t('automations.trigger_filters.trigger_payload_set_a_sample_under', 'trigger payload — set a sample under Settings → Manual trigger payload to test bindings.')}
            </div>
        </FilterShell>
    );
}

export function NextcloudShareFilterFields({ filter, setFilter }) {
    const { t } = useTranslation();
    return (
        <FilterShell title={t('automations.trigger_filters.nextcloud_share_received_filter', 'Nextcloud share.received filter')}>
            <FormRow label={t('automations.trigger_filters.sharer_actor_equals', 'Sharer (actor) equals')} hint={t('automations.trigger_filters.nextcloud_username_uid_of_the_person', 'Nextcloud username (uid) of the person who shared the item.')}>
                <input type="text" value={filter.actorEquals || ''} onChange={(e) => setFilter('actorEquals', e.target.value || undefined)}
                    className={inputClass() + ' font-mono'} />
            </FormRow>
            <FormRow label={t('automations.trigger_filters.kind', 'Kind')}>
                <select
                    value={filter.kindEquals || ''}
                    onChange={(e) => setFilter('kindEquals', e.target.value || undefined)}
                    className={inputClass()}
                >
                    <option value="">{t('automations.trigger_filters.any_file_or_folder', 'Any (file or folder)')}</option>
                    <option value="file">{t('automations.trigger_filters.file', 'file')}</option>
                    <option value="folder">{t('automations.trigger_filters.folder', 'folder')}</option>
                </select>
            </FormRow>
            <FormRow label={t('automations.trigger_filters.name_contains', 'Name contains')}>
                <input type="text" value={filter.nameContains || ''} onChange={(e) => setFilter('nameContains', e.target.value || undefined)}
                    className={inputClass()} />
            </FormRow>
        </FilterShell>
    );
}

export function NextcloudActivityFilterFields({ filter, setFilter }) {
    const { t } = useTranslation();
    return (
        <FilterShell title={t('automations.trigger_filters.nextcloud_activity_filter_advanced', 'Nextcloud activity filter (advanced)')}>
            <FormRow label={t('automations.trigger_filters.activity_type', 'Activity type')} hint={t('automations.trigger_filters.raw_activity_slug_e_g_file', 'Raw activity slug (e.g. file_created, comments, deck). Leave empty to match every type — and prefer file.new / file.changed / share.received as dedicated triggers.')}>
                <input type="text" value={filter.type || ''} onChange={(e) => setFilter('type', e.target.value || undefined)}
                    placeholder={t('automations.trigger_filters.comments', 'comments')} className={inputClass() + ' font-mono'} />
            </FormRow>
            <FormRow label={t('automations.trigger_filters.object_name_contains', 'Object name contains')}>
                <input type="text" value={filter.objectNameContains || ''} onChange={(e) => setFilter('objectNameContains', e.target.value || undefined)}
                    className={inputClass()} />
            </FormRow>
            <FormRow label={t('automations.trigger_filters.actor_equals', 'Actor equals')}>
                <input type="text" value={filter.actorEquals || ''} onChange={(e) => setFilter('actorEquals', e.target.value || undefined)}
                    className={inputClass() + ' font-mono'} />
            </FormRow>
        </FilterShell>
    );
}

export function NextcloudNotificationFilterFields({ filter, setFilter }) {
    const { t } = useTranslation();
    return (
        <FilterShell title={t('automations.trigger_filters.nextcloud_notification_filter', 'Nextcloud notification filter')}>
            <FormRow label={t('automations.trigger_filters.app', 'App')} hint={t('automations.trigger_filters.source_app_id_e_g_spreed', 'Source app id (e.g. spreed, files_sharing, dav, updatenotification).')}>
                <input type="text" value={filter.app || ''} onChange={(e) => setFilter('app', e.target.value || undefined)}
                    placeholder={t('automations.trigger_filters.spreed', 'spreed')} className={inputClass() + ' font-mono'} />
            </FormRow>
            <FormRow label={t('automations.trigger_filters.subject_contains', 'Subject contains')}>
                <input type="text" value={filter.subjectContains || ''} onChange={(e) => setFilter('subjectContains', e.target.value || undefined)}
                    className={inputClass()} />
            </FormRow>
        </FilterShell>
    );
}

export function SupportTicketResolvedFilterFields({ filter, setFilter }) {
    const { t } = useTranslation();
    return (
        <FilterShell title={t('automations.trigger_filters.support_inbox_ticket_resolved_filter_all', 'Support Inbox ticket.resolved filter (all optional)')}>
            <FormRow label={t('automations.trigger_filters.inbox_id', 'Inbox id')} hint={t('automations.trigger_filters.restrict_to_one_support_inbox_leave', 'Restrict to one support inbox. Leave empty to match every inbox.')}>
                <input type="text" value={filter.inboxId || ''} onChange={(e) => setFilter('inboxId', e.target.value || undefined)}
                    className={inputClass() + ' font-mono'} />
            </FormRow>
            <FormRow label={t('automations.trigger_filters.category_equals', 'Category equals')} hint={t('automations.trigger_filters.the_ai_classified_category_free_text', 'The AI-classified category. Free text — no enum yet.')}>
                <input type="text" value={filter.categoryEquals || ''} onChange={(e) => setFilter('categoryEquals', e.target.value || undefined)}
                    className={inputClass()} />
            </FormRow>
            <FormRow label={t('automations.trigger_filters.priority_equals', 'Priority equals')}>
                <select
                    value={filter.priorityEquals || ''}
                    onChange={(e) => setFilter('priorityEquals', e.target.value || undefined)}
                    className={inputClass()}
                >
                    <option value="">{t('automations.trigger_filters.any', 'Any')}</option>
                    <option value="low">{t('automations.trigger_filters.low', 'low')}</option>
                    <option value="medium">{t('automations.trigger_filters.medium', 'medium')}</option>
                    <option value="high">{t('automations.trigger_filters.high', 'high')}</option>
                    <option value="urgent">{t('automations.trigger_filters.urgent', 'urgent')}</option>
                </select>
            </FormRow>
            <FormRow label={t('automations.trigger_filters.tag_includes', 'Tag includes')} hint={t('automations.trigger_filters.fires_only_when_the_ticket_carries', 'Fires only when the ticket carries this tag.')}>
                <input type="text" value={filter.tagIncludes || ''} onChange={(e) => setFilter('tagIncludes', e.target.value || undefined)}
                    className={inputClass()} />
            </FormRow>
            <FormRow label={t('automations.trigger_filters.resolved_by', 'Resolved by')}>
                <select
                    value={filter.resolvedBy || ''}
                    onChange={(e) => setFilter('resolvedBy', e.target.value || undefined)}
                    className={inputClass()}
                >
                    <option value="">{t('automations.trigger_filters.any', 'Any')}</option>
                    <option value="ai">{t('automations.trigger_filters.ai', 'ai')}</option>
                    <option value="staff">{t('automations.trigger_filters.staff', 'staff')}</option>
                </select>
            </FormRow>
            <FormRow label={t('automations.trigger_filters.min_messages', 'Min messages')} hint={t('automations.trigger_filters.skip_tickets_with_fewer_messages_than', 'Skip tickets with fewer messages than this.')}>
                <input
                    type="number"
                    min={1}
                    value={filter.minMessages ?? ''}
                    onChange={(e) => setFilter('minMessages', e.target.value === '' ? undefined : Number(e.target.value))}
                    className={inputClass()}
                />
            </FormRow>
            <FormRow label={t('automations.trigger_filters.require_genuine_contact', 'Require genuine contact')} hint={t('automations.trigger_filters.default_on_only_real_customer_conversations', 'Default on: only real customer conversations fire. Unchecking also matches tickets without verified customer contact.')}>
                <label className="inline-flex items-center gap-2 text-sm">
                    <input
                        type="checkbox"
                        checked={filter.requireGenuineContact !== false}
                        onChange={(e) => setFilter('requireGenuineContact', e.target.checked ? undefined : false)}
                    />
                    {t('automations.trigger_filters.only_genuine_customer_conversations', 'Only genuine customer conversations')}
                </label>
            </FormRow>
        </FilterShell>
    );
}

// Lookup used by AppEventFields — `<provider>.<event>` → filter sub-form.
export function NextcloudFormsSubmittedFilterFields({ filter, setFilter }) {
    const { t } = useTranslation();
    return (
        <FilterShell title={t('automations.trigger_filters.nextcloud_form_filter_all_optional', 'Nextcloud form filter (all optional)')}>
            <FormRow label={t('automations.trigger_filters.form_id', 'Form ID')} hint={t('automations.trigger_filters.numeric_id_leave_empty_to_fire', 'Numeric id — leave empty to fire for every form you can see. Find it with the “List forms” action.')}>
                <input type="number" value={filter.formId ?? ''} onChange={(e) => setFilter('formId', e.target.value === '' ? undefined : Number(e.target.value))}
                    placeholder="51" className={inputClass() + ' font-mono'} />
            </FormRow>
            <FormRow label={t('automations.trigger_filters.form_hash', 'Form hash')} hint={t('automations.trigger_filters.the_token_in_the_form_s', 'The token in the form\'s share link — an alternative to the numeric id.')}>
                <input type="text" value={filter.formHash || ''} onChange={(e) => setFilter('formHash', e.target.value || undefined)}
                    placeholder={t('automations.trigger_filters.abc123def456', 'abc123def456')} className={inputClass() + ' font-mono'} />
            </FormRow>
            <FormRow label={t('automations.trigger_filters.title_contains', 'Title contains')}>
                <input type="text" value={filter.titleContains || ''} onChange={(e) => setFilter('titleContains', e.target.value || undefined)}
                    className={inputClass()} />
            </FormRow>
            <FormRow label={t('automations.trigger_filters.submitted_by', 'Submitted by')} hint={t('automations.trigger_filters.nextcloud_user_id_anonymous_submissions_have', 'Nextcloud user id. Anonymous submissions have no user, so this never matches them.')}>
                <input type="text" value={filter.submittedByEquals || ''} onChange={(e) => setFilter('submittedByEquals', e.target.value || undefined)}
                    className={inputClass() + ' font-mono'} />
            </FormRow>
            <div className="text-[11px] text-[var(--text-tertiary)] leading-snug">
                {t('automations.trigger_filters.the_answers_are_not_in_the', 'The answers are not in the trigger payload — follow this with the')}
                <code> Get form submissions </code> {t('automations.trigger_filters.action_bound_to', 'action, bound to')}
                <code> trigger.output.formId </code> {t('automations.trigger_filters.and', 'and')} <code> trigger.output.submissionId</code>.
            </div>
        </FilterShell>
    );
}

export function NextcloudTablesRowFilterFields({ filter, setFilter }) {
    const { t } = useTranslation();
    return (
        <FilterShell title={t('automations.trigger_filters.nextcloud_tables_row_filter_all_optional', 'Nextcloud Tables row filter (all optional)')}>
            <FormRow label={t('automations.trigger_filters.table_id', 'Table ID')} hint={t('automations.trigger_filters.numeric_id_find_it_with_the', 'Numeric id — find it with the “List tables” action.')}>
                <input type="number" value={filter.tableId ?? ''} onChange={(e) => setFilter('tableId', e.target.value === '' ? undefined : Number(e.target.value))}
                    placeholder="34" className={inputClass() + ' font-mono'} />
            </FormRow>
            <FormRow label={t('automations.trigger_filters.column_id', 'Column ID')} hint={t('automations.trigger_filters.numeric_column_id_to_test_a', 'Numeric column id to test a value against — from “List table columns”. The event carries column ids, not titles.')}>
                <input type="number" value={filter.columnId ?? ''} onChange={(e) => setFilter('columnId', e.target.value === '' ? undefined : Number(e.target.value))}
                    placeholder="13" className={inputClass() + ' font-mono'} />
            </FormRow>
            <FormRow label={t('automations.trigger_filters.value_equals', 'Value equals')}>
                <input type="text" value={filter.valueEquals ?? ''} onChange={(e) => setFilter('valueEquals', e.target.value === '' ? undefined : e.target.value)}
                    placeholder={t('automations.trigger_filters.approved', 'approved')} className={inputClass()} />
            </FormRow>
            <FormRow label={t('automations.trigger_filters.value_contains', 'Value contains')}>
                <input type="text" value={filter.valueContains || ''} onChange={(e) => setFilter('valueContains', e.target.value || undefined)}
                    className={inputClass()} />
            </FormRow>
            <FormRow label={t('automations.trigger_filters.only_when_that_column_changed', 'Only when that column changed')} hint={t('automations.trigger_filters.row_updates_fire_on_any_edit', 'Row updates fire on any edit. Tick this to fire only when the column above actually changed value.')}>
                <label className="inline-flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={filter.changedOnly === true} onChange={(e) => setFilter('changedOnly', e.target.checked || undefined)} />
                    {t('automations.trigger_filters.ignore_edits_that_left_this_column', 'Ignore edits that left this column alone')}
                </label>
            </FormRow>
            <FormRow label={t('automations.trigger_filters.changed_by', 'Changed by')} hint={t('automations.trigger_filters.nextcloud_user_id', 'Nextcloud user id.')}>
                <input type="text" value={filter.actorEquals || ''} onChange={(e) => setFilter('actorEquals', e.target.value || undefined)}
                    className={inputClass() + ' font-mono'} />
            </FormRow>
        </FilterShell>
    );
}

export function NextcloudTagFilterFields({ filter, setFilter }) {
    const { t } = useTranslation();
    return (
        <FilterShell title={t('automations.trigger_filters.nextcloud_tag_filter_all_optional', 'Nextcloud tag filter (all optional)')}>
            <FormRow label={t('automations.trigger_filters.tag_id', 'Tag ID')} hint={t('automations.trigger_filters.numeric_id_from_the_list_tags', 'Numeric id — from the “List tags” action. Nextcloud\'s tag event carries ids only, never the tag name.')}>
                <input type="number" value={filter.tagId ?? ''} onChange={(e) => setFilter('tagId', e.target.value === '' ? undefined : Number(e.target.value))}
                    placeholder="3" className={inputClass() + ' font-mono'} />
            </FormRow>
            <div className="text-[11px] text-[var(--text-tertiary)] leading-snug">
                {t('automations.trigger_filters.the_event_carries_no_file_path', 'The event carries no file path either — follow it with a Files action bound to')}
                <code> trigger.output.fileId </code> {t('automations.trigger_filters.if_you_need_the_path_or', 'if you need the path or contents.')}
            </div>
        </FilterShell>
    );
}

export function NextcloudCalendarMutationFilterFields({ filter, setFilter }) {
    const { t } = useTranslation();
    return (
        <FilterShell title={t('automations.trigger_filters.nextcloud_calendar_filter_all_optional', 'Nextcloud calendar filter (all optional)')}>
            <FormRow label={t('automations.trigger_filters.calendar_id_2', 'Calendar ID')} hint={t('automations.trigger_filters.numeric_id_of_the_calendar_leave', 'Numeric id of the calendar. Leave empty for all calendars.')}>
                <input type="number" value={filter.calendarId ?? ''} onChange={(e) => setFilter('calendarId', e.target.value === '' ? undefined : Number(e.target.value))}
                    className={inputClass() + ' font-mono'} />
            </FormRow>
            <div className="text-[11px] text-[var(--text-tertiary)] leading-snug">
                {t('automations.trigger_filters.nextcloud_s_calendar_webhook_carries_object', 'Nextcloud\'s calendar webhook carries object metadata only — there is no summary, start or end in it, so those cannot be filtered on here. Follow the trigger with')}
                <code> Get calendar event </code> {t('automations.trigger_filters.to_read_the_actual_event_or', 'to read the actual event, or use')}
                <strong> {t('automations.trigger_filters.calendar_event_upcoming', 'Calendar event upcoming')} </strong> {t('automations.trigger_filters.if_you_want_to_match_on', 'if you want to match on the title.')}
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
                    placeholder={t('automations.trigger_filters.sales_klant_van_dijk', 'sales, klant-van-dijk')}
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
    'google-sheets.spreadsheet.changed': SheetsChangedFilterFields,
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
