/**
 * Whether a page being filled in holds anything leaving would lose: an answer
 * to any question that collects one, blank by the server's own measure
 * (isBlank). Display fields hold nothing of the person's, and a text of only
 * spaces is not an answer.
 */

import { isBlank, isDisplayField } from './contract';
import type { Answers, FillField } from './fillTypes';

export function hasAnswers(fields: readonly FillField[], values: Answers): boolean {
    return fields.some((field) => !isDisplayField(field) && !isBlank(field, values[field.name]));
}
