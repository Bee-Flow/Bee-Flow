/**
 * Everything a step card shows, worked out once per row: the web
 * StepNodeBase's anatomy (family bar, icon tile, kicker with the step number,
 * name, summary line, the run badge or result chip, the issue count), read
 * from the definition, the last test run and the findings. Pure.
 */

import {
    nodeTypeLabel, stepFamily, type AnyNode, type FlowDefinition, type NodeFamily, type StepIssues, type Translate,
} from '@/features/flow-editor/model';
import { findNode, type RunRow } from '@/features/flow-editor/model/outline';
import type { IconName } from '@/shared/ui';

import { readablePath } from './readableText';
import { stepIconName } from './stepIcons';
import { cardLabelMap } from './stepLabels';
import { describeStepResult } from './stepResult';
import { stepName, stepSummary, summaryText, type SummaryContext } from './stepSummary';

export type { RunRow };

export interface CardContext extends SummaryContext {
    /** The last test run's rows, by step id. */
    runByStep?: ReadonlyMap<string, RunRow> | null;
    issuesByStep?: ReadonlyMap<string, StepIssues> | null;
    /** "AI STEP · 3": model/flowOrder `stepNumbers`. */
    numbers?: ReadonlyMap<string, number | string> | null;
}

export interface CardModel {
    nodeId: string;
    type: string;
    family: NodeFamily | null;
    icon: IconName;
    /** The kicker: what kind of step, and its number. */
    kicker: string;
    name: string;
    sub: string;
    subMuted: boolean;
    /** A loop's list as a person reads it ("‹gmail search ▸ Results›"), '' when none is picked; null for any other step. */
    list: string | null;
    status: string | null;
    /** What the settled run produced ("3 items", "failed"), or null. */
    result: string | null;
    pinned: boolean;
    disabled: boolean;
    /** Stop with an error: the end card painted in the error colour. */
    errorTone: boolean;
    errors: number;
    warnings: number;
}

function kickerFor(node: AnyNode, number: number | string | undefined, t: Translate): string {
    const kind = node.type === 'trigger' && node.kind === 'app_trigger'
        ? t('automations.trigger.app_button', 'Button in an app')
        : nodeTypeLabel(node.type, t) || t('automations.builder.node_generic', 'Step');
    return number != null ? `${kind} · ${number}` : kind;
}

/**
 * The card for the step at `address`, or null when it is gone. A context
 * without step names (a canvas mounted on its own, a test) gets them from
 * the definition, so a reference never reads as a bare id.
 */
export function cardModel(def: FlowDefinition, address: string, given: CardContext): CardModel | null {
    const node = findNode(def, address);
    if (!node) return null;
    const ctx = given.stepLabelById ? given : { ...given, stepLabelById: cardLabelMap(def, given.t) };
    const run = ctx.runByStep?.get(node.id) ?? null;
    const issues = ctx.issuesByStep?.get(node.id);
    const { text, muted } = summaryText(stepSummary(node, ctx));
    const pinned = node.pinnedOutput !== undefined && node.pinnedOutput !== null;
    return {
        nodeId: node.id,
        type: node.type,
        family: stepFamily(node.type),
        icon: stepIconName(node),
        kicker: kickerFor(node, ctx.numbers?.get(address), ctx.t),
        name: stepName(node, ctx),
        sub: text,
        subMuted: muted,
        list: node.type === 'loop' ? readablePath(node.overRef, ctx.stepLabelById, ctx.t) : null,
        status: run?.status ?? null,
        result: describeStepResult(run, ctx.t),
        pinned,
        disabled: !!node.disabled,
        errorTone: node.type === 'stop_error',
        errors: issues?.errors.length ?? 0,
        warnings: issues?.warnings.length ?? 0,
    };
}
