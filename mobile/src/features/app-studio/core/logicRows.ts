/**
 * The Logic tab's model: the port of agent-hub AppStudio/editor/logicRows.js
 * (its default export is `logicRows` here), with the helpers it pulls from
 * the web's nodeLogicSummary.js (eventText), actionLabels.js (describeAction)
 * and styleKnobMeta.js (TYPE_EVENT_LISTS). Split across core/logic/*.
 * logicRows.lockstep.test.ts runs every one against the web original.
 */

export { collectBoundTableIds, countWiredLogic, logicRows, type LogicRow, type TitleFor } from './logic/rows';
export { assignNotices, noticesForRow, routineRows, routineTouchesTables, type Notice, type RoutineRowsArgs } from './logic/routines';
export { TYPE_EVENT_LISTS, eventSlotsOf, eventText, eventsForType, nOf } from './logic/events';
export { actionOptions, describeAction, type DescribeOptions } from './logic/describeAction';
