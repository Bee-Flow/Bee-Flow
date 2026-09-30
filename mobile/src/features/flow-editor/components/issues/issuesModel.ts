/**
 * The findings, as the issues pill and its list show them — the phone's
 * FloatingValidationPill: never a raw step id (each record names its step by
 * the author's label), and each one knows where to go: the step it is about
 * and the editor section that holds the control to fix it (sectionForIssue).
 * Pure.
 */

import { translate } from '@/core/i18n';
import { cardLabelMap } from '@/features/flow-editor/components/outline/stepLabels';
import {
    humanizeIssueText, resolveOwningStepId, sectionForIssue,
    type FlowDefinition, type Translate, type ValidationIssue,
} from '@/features/flow-editor/model';
import { findNode } from '@/features/flow-editor/model/outline';

import { locateIssue } from './issueLocation';

export interface IssueSetLike {
    errors: readonly ValidationIssue[];
    warnings: readonly ValidationIssue[];
}

export interface IssueRow {
    key: string;
    severity: 'error' | 'warning';
    code: string | null;
    message: string;
    hint: string | null;
    /** The step it is about, when the path names one: its address (`loop/child` for a held step). */
    stepId: string | null;
    /** The flowlet that step is in; null in the routine itself. */
    flowlet: string | null;
    stepLabel: string | null;
    /** The node editor section that fixes it; null for a field that is always shown. */
    section: string | null;
}

interface Where {
    def: FlowDefinition;
    labels: Map<string, string>;
}

/** Where the step is: the path's own address first, the web's id match when the path names none. */
function whereIs(rec: ValidationIssue, def: FlowDefinition): { address: string | null; flowlet: string | null } {
    const found = locateIssue(rec, def);
    return found ?? { address: resolveOwningStepId(rec, def), flowlet: null };
}

/** The step itself, found where it lives, with the name its label map knows it by. */
function stepAt(def: FlowDefinition, address: string | null, flowlet: string | null, labels: Map<string, string>) {
    const step = findNode(flowlet ? def.layers?.[flowlet] : def, address);
    const leaf = address?.split('/').pop() ?? '';
    return { step, name: step ? (labels.get(leaf) ?? null) : null };
}

function rowFor(rec: ValidationIssue, severity: IssueRow['severity'], index: number, { def, labels }: Where): IssueRow {
    const { address, flowlet } = whereIs(rec, def);
    const { step, name } = stepAt(def, address, flowlet, labels);
    return {
        key: `${severity}:${index}:${rec.code ?? ''}:${rec.path ?? ''}`,
        severity,
        code: rec.code ?? null,
        message: humanizeIssueText(String(rec.message ?? ''), labels),
        hint: rec.hint ? humanizeIssueText(rec.hint, labels) : null,
        stepId: step ? address : null,
        flowlet: step ? flowlet : null,
        stepLabel: name,
        section: step ? sectionForIssue(step, rec) : null,
    };
}

/** Every step's name — in loops, branches and flowlets too — so no message is left saying an id. */
function allLabels(def: FlowDefinition): Map<string, string> {
    const labels = new Map<string, string>();
    for (const layer of Object.values(def.layers ?? {})) for (const [id, name] of cardLabelMap(layer, translate)) labels.set(id, name);
    for (const [id, name] of cardLabelMap(def, translate)) labels.set(id, name);
    return labels;
}

/** Every finding, errors first, in words. */
export function issueRows(issues: IssueSetLike | null | undefined, def: FlowDefinition | null | undefined): IssueRow[] {
    if (!issues || !def) return [];
    const where: Where = { def, labels: allLabels(def) };
    return [
        ...issues.errors.map((rec, i) => rowFor(rec, 'error', i, where)),
        ...issues.warnings.map((rec, i) => rowFor(rec, 'warning', i, where)),
    ];
}

export interface PillSummary {
    total: number;
    tone: 'error' | 'warning';
    text: string;
}

/**
 * What the collapsed pill says: the one record's own words when there is
 * exactly one ("1 binding missing · Send reply"), else the count. Null when
 * there is nothing to show — a healthy routine has no pill at all.
 */
export function pillSummary(rows: readonly IssueRow[], t: Translate): PillSummary | null {
    const total = rows.length;
    if (total === 0) return null;
    const hasErrors = rows.some((r) => r.severity === 'error');
    const tone = hasErrors ? 'error' : 'warning';
    const only = total === 1 ? rows[0] : undefined;
    if (only) return { total, tone, text: only.stepLabel ? `${only.message} · ${only.stepLabel}` : only.message };
    const text = hasErrors
        ? t('mobile.flow.issues.count_problems', '{n} problems', { n: total })
        : t('mobile.flow.issues.count_warnings', '{n} warnings', { n: total });
    return { total, tone, text };
}
