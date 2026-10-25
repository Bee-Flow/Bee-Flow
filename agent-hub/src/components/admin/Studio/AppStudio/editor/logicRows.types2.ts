import { describeAction } from '../inspector/actionLabels';
import type { AppAction, AppDefinition } from '../inspector/appDefinition';
import type { TranslateFn } from '../../../../../hooks/useTranslation';
import type { LogicRow, RowExtra, MakeEmitterArgs } from './logicRows.types';

export function actionsOf(definition: AppDefinition | null): Record<string, AppAction> {
    return definition?.actions && typeof definition.actions === 'object' ? definition.actions : {};
}

/**
 * What sits behind an action id, in the language of the author — or, if the action is not there, says so.
 * `describeAction` names; that there is NOTHING to name is a different message and must not pass as a name.
 */
export function whatOf(t: TranslateFn, actionId: string, definition: AppDefinition | null, titleFor: ((automationId?: string | null) => string | null) | null) {
    const action = actionsOf(definition)[actionId];
    if (!action) return t('app_studio.canvas.mark_missing_action', 'points at an action that no longer exists');
    return describeAction(actionId, action, definition, titleFor);
}

export function baseRow(extra: RowExtra & Pick<LogicRow, 'what'>): LogicRow {
    return {
        kind: 'event',
        wired: true,
        screenId: null,
        screenName: '',
        nodeId: null,
        nodeType: null,
        event: null,
        surface: null,
        surfaceLabel: null,
        actionId: null,
        actionKind: null,
        automationId: null,
        path: '',
        descriptive: false,
        ...extra,
    };
}

export function makeEmitter({ rows, definition, titleFor, t, referenced }: MakeEmitterArgs) {
    const actions = actionsOf(definition);
    return {
        plain(row: RowExtra) {
            rows.push(baseRow({ ...row, wired: false, what: t('app_studio.logic.no_action_yet', 'No action yet') }));
        },
        wired(row: RowExtra, actionId: string) {
            const action = actions[actionId];
            referenced.add(actionId);
            rows.push(baseRow({
                ...row,
                wired: true,
                actionId,
                actionKind: action?.kind || null,
                automationId: action?.kind === 'run_automation' ? (action.automationId || null) : null,
                what: whatOf(t, actionId, definition, titleFor),
            }));
        },
    };
}

/**
 * Every event slot that this component type MAY carry, wired or not.
 *
 * The unwired half is the core of this screen. Today such a slot disappears without a trace: the canvas badge
 * skips a falsy actionId (nodeLogicSummary.js), "Logic n" does not count it, and the validator is silent about
 * it except on a button and a form. So it stays here.
 */
export type Emitter = ReturnType<typeof makeEmitter>;
