import { FileSpreadsheet, TableProperties } from 'lucide-react';
import { stepItem } from './stepItem';

/** The spreadsheet pair: open a file as tables, then work on a table without code. */
export const TABLE_ITEMS = [
    stepItem('read_table', 'read_table', FileSpreadsheet,
        'read table spreadsheet csv excel xlsx xls ods workbook sheet open import upload file rows columns data'),
    stepItem('table', 'table', TableProperties,
        'edit table spreadsheet csv excel sheet columns rows join merge lookup filter group pivot summarise summarize count total average derive calculate bucket bands sample select rename pseudonymise anonymise anonymize segments describe'),
];
