/**
 * The condition-builder half of agent-hub `utils/bindingHelpers.ts`: split a
 * simple `<path> <op> <value>` expression into slots, and serialise slots and
 * bindings back into the restricted expression grammar. The web's functions,
 * the generated mirror under bindings/mirror/utils/ (npm run gen:shared);
 * pinned by bindingHelpers.lockstep.test.ts.
 */

import { buildConditionExpr as webBuildConditionExpr } from './mirror/utils/bindingHelpers';
import type { BindingValue } from './types';
import { renderBindingValue } from '../model/route/bindingText';

export { parseSimpleCondition } from './mirror/utils/bindingHelpers';

// One copy of "a binding as an expression fragment", beside the condition
// model that writes with it (it sits below this layer).
export { renderBindingValue };

export const buildConditionExpr = webBuildConditionExpr as (leftPath: unknown, op: string, rightBinding: BindingValue) => string;
