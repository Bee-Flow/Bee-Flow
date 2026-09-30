/**
 * The approval step, the pure half of the web's ApprovalFields and
 * ApprovalStagesEditor (approvalEditors.jsx, approvalStages.jsx): the deadline
 * and reminder choices, a seat as one picker value (`u:<id>` / `g:<id>`), the
 * mode switch between one round (a person, a panel, a final sign-off) and a
 * chain of stages — which supersede one another, so switching carries over
 * everything the other shape can express — and a question's binding name,
 * minted ONCE from its label and frozen after. Pinned by
 * approval.lockstep.test.ts.
 */

import type { ApprovalDirectory } from '@/features/flow-editor/api';
import { newStageKey, STAGE_RULES, stageSeats, type FormDraft } from '@/features/flow-editor/formState';

import { msg, type Msg } from '../declarative/spec';
import { slugifyFieldName } from '../form/formModel';

export type Seat = { userId?: string; groupId?: string } | null;
export type Stage = Record<string, unknown> & { key?: string; approvers?: Seat[]; rule?: string; quorum?: number; when?: string };
export type Question = Record<string, unknown> & { name?: string; label?: string; type?: string; required?: boolean; options?: unknown };

/** How long an approval may wait; 0 is a real value — "never expire" — bounded by the engine's 720 h. */
export const DEADLINE_CHOICES: readonly { value: number; label: Msg }[] = [
    { value: 4, label: msg('mobile.flow.approval.h4', '4 hours') },
    { value: 24, label: msg('mobile.flow.approval.d1', '1 day') },
    { value: 72, label: msg('mobile.flow.approval.d3', '3 days') },
    { value: 168, label: msg('mobile.flow.approval.d7', '7 days') },
    { value: 336, label: msg('mobile.flow.approval.d14', '14 days') },
    { value: 720, label: msg('mobile.flow.approval.d30', '30 days') },
    { value: 0, label: msg('mobile.flow.approval.no_deadline', 'No deadline') },
];

/** Reminder and escalation delays: opt-in ('' = off), so no zero. */
export const CLOCK_CHOICES: readonly { value: number; label: Msg }[] = [
    { value: 1, label: msg('mobile.flow.approval.h1', '1 hour') },
    { value: 4, label: msg('mobile.flow.approval.h4', '4 hours') },
    { value: 24, label: msg('mobile.flow.approval.d1', '1 day') },
    { value: 48, label: msg('mobile.flow.approval.d2', '2 days') },
    { value: 72, label: msg('mobile.flow.approval.d3', '3 days') },
    { value: 168, label: msg('mobile.flow.approval.d7', '7 days') },
];

export const ANSWER_TYPES: readonly { value: string; label: Msg }[] = [
    { value: 'text', label: msg('mobile.flow.approval.short_text', 'Short text') },
    { value: 'textarea', label: msg('mobile.flow.approval.long_text', 'Long text') },
    { value: 'number', label: msg('mobile.flow.approval.number', 'Number') },
    { value: 'date', label: msg('mobile.flow.approval.date', 'Date') },
    { value: 'select', label: msg('mobile.flow.approval.choice', 'Choice') },
    { value: 'checkbox', label: msg('mobile.flow.approval.yes_no', 'Yes/no') },
    { value: 'email', label: msg('mobile.flow.approval.email', 'Email') },
];

export const MAX_ATTACHMENTS = 5;
export const MAX_QUESTIONS = 20;
export const MAX_PANEL_SEATS = 10;

/** The stored hours, or 168; a value no choice offers is kept as its own choice. */
export function deadlineChoices(raw: unknown): { hours: number; choices: { value: number; label: Msg }[] } {
    const hours = Number.isFinite(Number(raw)) && raw !== '' && raw !== null ? Number(raw) : 168;
    const choices = DEADLINE_CHOICES.some((c) => c.value === hours) ? [...DEADLINE_CHOICES] : [...DEADLINE_CHOICES, { value: hours, label: msg('mobile.flow.approval.n_hours', '{n} hours', { n: hours }) }];
    return { hours, choices };
}

// ── Seats ──────────────────────────────────────────────────────────────

export function seatValue(seat: unknown): string {
    const s = seat as Seat;
    if (s?.userId) return `u:${s.userId}`;
    if (s?.groupId) return `g:${s.groupId}`;
    return '';
}

export function decodeSeat(encoded: string): Seat {
    if (!encoded) return null;
    return encoded.slice(0, 1) === 'u' ? { userId: encoded.slice(2) } : { groupId: encoded.slice(2) };
}

const picked = (seat: Seat) => !!seat && !!(seat.userId || seat.groupId);

/** The directory as picker options: people, then groups (described as such). */
export function directoryOptions(directory: ApprovalDirectory | null | undefined, groupsWord: string): { value: string; label: string; description?: string }[] {
    return [
        ...(directory?.members ?? []).map((m) => ({ value: `u:${m.id}`, label: m.name })),
        ...(directory?.groups ?? []).map((g) => ({ value: `g:${g.id}`, label: g.name, description: groupsWord })),
    ];
}

/** "More approvers": the panel starts with the current approver, so nothing picked is lost. */
export const startPanel = (draft: FormDraft): FormDraft => ({ approvers: draft.assignee ? [draft.assignee, null] : [null], assignee: null });

/** Choosing an escalation target also gives it a delay (24 h) if it had none; clearing clears both. */
export function chooseEscalation(draft: FormDraft, encoded: string): FormDraft {
    if (!encoded) return { escalateTo: null, escalateAfterHours: '' };
    return { escalateTo: decodeSeat(encoded), ...(draft.escalateAfterHours ? {} : { escalateAfterHours: 24 }) };
}

// ── One round ⇄ a chain of stages ─────────────────────────────────────

/** Turn stages on: the chosen approvers become stage 1, a final sign-off stage 2, then the one-round fields clear. */
export function stagesFrom(draft: FormDraft, finalStageName: string): FormDraft {
    const panel = (Array.isArray(draft.approvers) ? draft.approvers : []) as Seat[];
    const chosen = panel.filter(picked);
    const first = chosen.length ? chosen : draft.assignee ? [draft.assignee as Seat] : [];
    const several = chosen.length >= 2;
    const rule = several && STAGE_RULES.includes(draft.rule as string) ? (draft.rule as string) : 'all';
    const chain: Stage[] = [
        {
            key: newStageKey([]),
            name: '',
            description: '',
            approvers: first.length ? first : [null],
            rule: several ? rule : 'all',
            ...(several && rule === 'quorum' ? { quorum: Number(draft.quorum) || 2 } : {}),
        },
    ];
    const finalSeat = draft.finalApprover as Seat;
    if (picked(finalSeat)) chain.push({ key: newStageKey(chain), name: finalStageName, description: '', approvers: [finalSeat], rule: 'first' });
    return { stages: chain, assignee: null, approvers: [], finalApprover: null, escalateTo: null, escalateAfterHours: '' };
}

/** Back to one round: stage 1 becomes the approver(s), a one-seat last stage the final sign-off. */
export function oneRoundFrom(draft: FormDraft): FormDraft {
    const stages = (Array.isArray(draft.stages) ? draft.stages : []) as Stage[];
    const first = stages[0] ?? null;
    const firstSeats = stageSeats(first) as Seat[];
    const last = stages.length > 1 ? stages[stages.length - 1] : null;
    const lastSeats = stageSeats(last) as Seat[];
    const out: FormDraft = { stages: [], finalApprover: lastSeats.length === 1 ? lastSeats[0] : null };
    if (firstSeats.length > 1) {
        out.approvers = firstSeats;
        out.assignee = null;
        out.rule = STAGE_RULES.includes(first?.rule as string) ? first?.rule : 'all';
        if (first?.rule === 'quorum') out.quorum = Math.min(Math.max(Number(first.quorum) || 2, 1), firstSeats.length);
    } else {
        out.approvers = [];
        out.assignee = firstSeats[0] ?? null;
    }
    return out;
}

/** A new stage: the lowest free `sN` key — never positional, or votes would follow the wrong stage. */
export const addStage = (stages: readonly Stage[]): Stage[] => [...stages, { key: newStageKey(stages), name: '', description: '', approvers: [null], rule: 'all' }];

/** "N of M" for the quorum picker: 1..seats, the stored value clamped into it. */
export const quorumValue = (raw: unknown, seats: number): number => Math.min(Math.max(Number(raw) || 2, 1), seats);

// ── Questions ──────────────────────────────────────────────────────────

/** The one name the minting may overwrite: nothing can bind a question that has no label yet. */
const PLACEHOLDER_QUESTION_NAME = /^q\d+$/;

export const storedQuestionName = (q: Question | null | undefined): string => (typeof q?.name === 'string' ? q.name.trim() : '');

/** A question's binding name — minted once from the label, then frozen (a later step may bind it). */
export function approvalQuestionName(question: Question | null | undefined, index: number, questions: readonly (Question | null)[] = []): string {
    const current = storedQuestionName(question);
    if (current && !PLACEHOLDER_QUESTION_NAME.test(current)) return current;
    const label = typeof question?.label === 'string' ? question.label.trim() : '';
    if (!label) return current || `q${index + 1}`;
    const taken = new Set(questions.map((q, i) => (i === index ? null : q?.name)).filter((n): n is string => !!n));
    return slugifyFieldName(label, taken);
}

/** "Add a question": the placeholder name skips the ones in use. */
export function addQuestion(questions: readonly Question[]): Question[] {
    const taken = new Set(questions.map((q) => q?.name).filter(Boolean));
    let n = questions.length + 1;
    while (taken.has(`q${n}`)) n += 1;
    return [...questions, { name: `q${n}`, label: '', type: 'text', required: false }];
}

/** A choice question's options as the line shown, and back. */
export const joinChoices = (options: unknown): string =>
    (Array.isArray(options) ? options : [])
        .map((o) => (o && typeof o === 'object' ? ((o as { label?: unknown; value?: unknown }).label ?? (o as { value?: unknown }).value) : o))
        .filter(Boolean)
        .join(', ');

export const splitChoices = (text: string): string[] =>
    text
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
