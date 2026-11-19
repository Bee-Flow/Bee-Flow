// @typecheck strict
// English GUI defaults — namespace "automation_write_table": every key whose part before the first "." is "automation_write_table".
// Merged into GUI_DEFAULTS by ./index.js. The frontend copy (agent-hub/src/i18n/en-defaults.js)
// is GENERATED from these files: after an edit, run `npm run i18n:gen`.
module.exports = {
    // The settings and the canvas card of the Write table step (a table out as an .xlsx or .csv file).
    'automation_write_table.add_column': 'Add a column',
    'automation_write_table.advanced': 'Advanced',
    'automation_write_table.card.csv': 'As a CSV file',
    'automation_write_table.card.xlsx': 'As an Excel file',
    'automation_write_table.column': 'Column {n}',
    'automation_write_table.column_placeholder': 'Column of the table',
    'automation_write_table.columns': 'Columns',
    'automation_write_table.columns_help': 'Which columns go into the file, in this order, each with the heading it gets. No columns: all of them, as they are.',
    'automation_write_table.delimiter': 'Separator between the columns',
    'automation_write_table.delimiter_comma': 'Comma',
    'automation_write_table.delimiter_help': 'Excel opens a CSV file with its own list separator: a semicolon in Dutch.',
    'automation_write_table.delimiter_semicolon': 'Semicolon (Excel in Dutch and many other languages)',
    'automation_write_table.delimiter_tab': 'Tab',
    'automation_write_table.file_name': 'File name',
    'automation_write_table.file_name_help': 'Without the extension. It may hold values of earlier steps, such as a project number from the form. Empty: the name of this step.',
    'automation_write_table.format': 'File type',
    'automation_write_table.format_csv': 'CSV (.csv)',
    'automation_write_table.format_help': 'Excel keeps numbers as numbers and can mark rows. CSV is plain text that every program reads.',
    'automation_write_table.format_xlsx': 'Excel (.xlsx)',
    'automation_write_table.header': 'Heading of column {n}',
    'automation_write_table.header_placeholder': 'Heading (optional)',
    'automation_write_table.highlight': 'Mark rows where this column is filled in',
    'automation_write_table.highlight_help': 'For example a column with remarks or flags: the rows to check get a colour in the Excel file. Empty: no row is marked.',
    'automation_write_table.keep': 'Keep the file for (days)',
    'automation_write_table.keep_help': 'After this many days the file is deleted. From 1 to 90.',
    'automation_write_table.remove_column': 'Remove column {n}',
    'automation_write_table.sheet_name': 'Sheet name',
    'automation_write_table.sheet_name_help': 'The name of the sheet in the Excel file. Empty: the name of this step.',
    'automation_write_table.source': 'Table to write',
    'automation_write_table.source_help': 'A table from an earlier step: a Read table or Edit table step, or a list of rows.',
};
