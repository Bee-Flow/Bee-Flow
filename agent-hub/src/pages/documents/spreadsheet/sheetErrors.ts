// The error codes a cell can show, in plain words (for the tooltip).

import type { TranslateFn } from '../../../hooks/useTranslation';

const KNOWN_ERRORS: Array<[string, string, string]> = [
    ['#DIV/0', 'spreadsheet.error.div0', 'Division by zero.'],
    ['#REF', 'spreadsheet.error.ref', 'The formula points at a cell that does not exist.'],
    ['#NAME', 'spreadsheet.error.name', 'The formula uses a function or name that is not known.'],
    ['#VALUE', 'spreadsheet.error.value', 'The formula got a value of the wrong kind, such as text where a number is needed.'],
    ['#CIRC', 'spreadsheet.error.cycle', 'The formula depends on its own result (a circular reference).'],
    ['#N/A', 'spreadsheet.error.na', 'No value is available.'],
    ['#ERROR', 'spreadsheet.error.syntax', 'The formula is not written correctly.'],
    ['#NUM', 'spreadsheet.error.num', 'The result is not a valid number.'],
];

export function explainError(t: TranslateFn, error: string): string {
    const hit = KNOWN_ERRORS.find(([code]) => error.toUpperCase().includes(code));
    return hit ? t(hit[1], hit[2]) : t('spreadsheet.error.generic', 'This formula cannot be calculated: {error}', { error });
}
