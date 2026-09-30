/**
 * Training & competence (ISO 27001 clause 7.2; web: pages/TrainingPage):
 * per-person policy acknowledgements with a training attestation, and the
 * ISMS obligations clock.
 *
 * Server: routes/compliance/isoProcess.js — TrainingAttestBody,
 * CreateObligation / ObligationPatch (`.strict()`; `due_at` cannot be
 * emptied on a patch, so the edit form requires it). The member's e-mail in
 * GET /iso/training is not read.
 */

import { OBLIGATION_KINDS } from './choices';
import { createBody } from './fields';
import { COMPLIANCE, seg, str } from './paths';
import { owner } from './recordsAudit';
import type { Choice, FieldSpec, RecordType } from './types';
import { readTrainingBundle } from '../api/readersRegisters';

const put = (id: unknown, body: Record<string, unknown>) => ({ method: 'PUT' as const, path: `${COMPLIANCE}/iso/obligations/${seg(id)}`, body });

const TRAINING_PATH = `${COMPLIANCE}/iso/training`;

const TRAINED: readonly Choice[] = [
    { value: 'attested', label: { i18nKey: 'mobile.compliance.trained', en: 'Training attested' }, tone: 'success' },
    { value: 'never', label: { i18nKey: 'compliance.training_never_attested', en: 'Never attested' }, tone: 'warning' },
];

export const PERSONNEL: RecordType = {
    id: 'personnel',
    section: 'training',
    noun: { i18nKey: 'compliance.training_col_member', en: 'Member' },
    plural: { i18nKey: 'compliance.training_personnel_title', en: 'People & competence' },
    icon: 'GraduationCap',
    intro: { i18nKey: 'compliance.training_intro', en: 'Who acknowledged which policy, who was trained, and what the ISMS owes itself next.' },
    list: {
        paths: [TRAINING_PATH],
        select: ([raw]) => ({
            rows: readTrainingBundle(raw).personnel.map((p) => ({
                ...p,
                acks: p.policy_total === null ? null : `${p.policy_acks ?? 0}/${p.policy_total}`,
                trained: p.attested_at ? 'attested' : 'never',
            })),
            context: null,
        }),
    },
    idOf: (r) => str(r.user_id),
    titleOf: (r) => str(r.displayName),
    meta: ['acks'],
    status: { key: 'trained', options: TRAINED },
    facts: [
        { key: 'acks', label: { i18nKey: 'compliance.training_col_acks', en: 'Policies' }, kind: 'text' },
        { key: 'learning_done', label: { i18nKey: 'compliance.training_col_learning', en: 'Learning' }, kind: 'number' },
        { key: 'attested_at', label: { i18nKey: 'mobile.compliance.trained', en: 'Training attested' }, kind: 'date' },
        { key: 'attested_note', label: { i18nKey: 'compliance.training_attest_note', en: 'Note' }, kind: 'text' },
    ],
    empty: { title: { i18nKey: 'compliance.training_no_personnel', en: 'No members to show' } },
    actions: [
        {
            id: 'attest',
            label: { i18nKey: 'compliance.training_attest', en: 'Attest training' },
            icon: 'BadgeCheck',
            fields: [{ key: 'note', label: { i18nKey: 'compliance.training_attest_note', en: 'Note' }, kind: 'text', placeholder: { i18nKey: 'compliance.training_attest_note_ph', en: 'Optional note — course, provider, certificate…' } }],
            request: (r, v) => ({ method: 'POST', path: `${TRAINING_PATH}/${seg(r.user_id)}/attest`, body: str(v.note).trim() ? { note: str(v.note).trim() } : {} }),
            success: { i18nKey: 'compliance.training_toast_attested', en: 'Training attestation recorded' },
        },
    ],
};

const OBLIGATION_FIELDS: readonly FieldSpec[] = [
    { key: 'title', label: { i18nKey: 'compliance.obl_f_title', en: 'Title' }, kind: 'text', required: true },
    { key: 'subject', label: { i18nKey: 'compliance.obl_f_subject', en: 'Subject' }, kind: 'text', placeholder: { i18nKey: 'compliance.obl_f_subject_ph', en: 'Policy slug, control ref, supplier… (optional)' } },
    { key: 'due_at', label: { i18nKey: 'compliance.obl_f_due', en: 'Due date' }, kind: 'date', required: true },
    { key: 'recur_months', label: { i18nKey: 'compliance.obl_f_recur', en: 'Repeat (months)' }, kind: 'number', hint: { i18nKey: 'compliance.obl_recur_hint', en: 'With a repeat interval, completing creates the next occurrence automatically.' } },
    owner('compliance.obl_f_owner'),
];
const OBLIGATION_KIND: FieldSpec = { key: 'kind', label: { i18nKey: 'compliance.obl_f_kind', en: 'Kind' }, kind: 'choice', options: OBLIGATION_KINDS, initial: 'custom' };

const OBLIGATION_STATES: readonly Choice[] = [
    { value: 'open', label: { i18nKey: 'compliance.nc_due', en: 'Due' }, tone: 'info' },
    { value: 'overdue', label: { i18nKey: 'compliance.nc_overdue', en: 'Overdue' }, tone: 'error' },
    { value: 'done', label: { i18nKey: 'compliance.obl_complete', en: 'Mark done' }, tone: 'success' },
];

export const OBLIGATIONS: RecordType = {
    id: 'obligations',
    section: 'training',
    noun: { i18nKey: 'compliance.obl_col_title', en: 'Obligation' },
    plural: { i18nKey: 'compliance.obl_title', en: 'Obligations & deadlines' },
    icon: 'CalendarClock',
    intro: { i18nKey: 'compliance.obl_desc', en: 'The ISMS clock: reviews, audits, training and tests with owners and due dates.' },
    list: {
        paths: [TRAINING_PATH],
        select: ([raw]) => ({
            rows: readTrainingBundle(raw).obligations.map((o) => ({
                ...o,
                state: o.completed_at ? 'done' : o.due_at && Date.parse(o.due_at) < Date.now() ? 'overdue' : 'open',
            })),
            context: null,
        }),
    },
    idOf: (r) => str(r.id),
    titleOf: (r) => str(r.title),
    meta: ['kind', 'due_at'],
    status: { key: 'state', options: OBLIGATION_STATES },
    facts: [OBLIGATION_KIND, ...OBLIGATION_FIELDS.slice(1)],
    search: ['subject'],
    empty: { title: { i18nKey: 'compliance.obl_empty_title', en: 'Nothing on the clock' } },
    create: {
        label: { i18nKey: 'compliance.obl_add', en: 'Add obligation' },
        fields: [OBLIGATION_KIND, ...OBLIGATION_FIELDS],
        request: (v) => ({ method: 'POST', path: `${COMPLIANCE}/iso/obligations`, body: createBody([OBLIGATION_KIND, ...OBLIGATION_FIELDS], v) }),
        success: { i18nKey: 'compliance.obl_toast_created', en: 'Obligation created' },
    },
    edit: { fields: OBLIGATION_FIELDS, request: (r, body) => put(r.id, body) },
    actions: [
        {
            id: 'complete',
            label: { i18nKey: 'compliance.obl_complete', en: 'Mark done' },
            icon: 'Check',
            when: (r) => !r.completed_at,
            request: (r) => ({ method: 'POST', path: `${COMPLIANCE}/iso/obligations/${seg(r.id)}/complete`, body: {} }),
            success: { i18nKey: 'compliance.obl_toast_completed', en: 'Obligation completed' },
        },
    ],
};
