import { FileText } from 'lucide-react';
import type { StepKindModule } from '../stepKinds';

/**
 * The editor's entry for the `generate_document` step (server/appStudio/componentSpecs/steps/generate_document.js):
 * the app's own markdown rendered into a PDF or Word file on the server, stored as an attachment like
 * generate_file. Its fields are drawn from the spec by StepSettings.
 */
const NS = 'studio_apps_step_document';

const entry: StepKindModule = {
    kind: 'generate_document',
    meta: {
        label: 'Make a PDF or Word file', labelKey: `${NS}.label`, group: 'Data', icon: FileText,
        blurb: 'Turn text, such as a report or an AI summary, into a PDF or Word file.',
        blurbKey: `${NS}.blurb`,
        server: true,
    },
    // resultVar matches the other file steps', so a download step that follows reads the same name.
    newStep: () => ({
        kind: 'generate_document',
        content: { kind: 'formula', expr: 'vars.result' },
        format: 'pdf',
        fileName: { kind: 'static', value: 'document' },
        resultVar: 'file',
    }),
    fields: {
        content: { label: [`${NS}.field_content`, 'Text'], hint: [`${NS}.hint_content`, 'Markdown: # headings, lists, tables. For example the text an AI step wrote (vars.<name>.text) or a template over the record.'] },
        contentFormat: { label: [`${NS}.field_content_format`, 'Text format'] },
        title: { hint: [`${NS}.hint_title`, 'Optional. The heading of the first page and the title of the file.'] },
        format: { label: [`${NS}.field_format`, 'File type'] },
        fileName: { label: [`${NS}.field_file_name`, 'File name'], hint: [`${NS}.hint_file_name`, 'Without extension; .pdf or .docx is added.'] },
        houseStyle: { label: [`${NS}.field_house_style`, 'House style'], hint: [`${NS}.hint_house_style`, 'A Word file uses the organisation’s Word house style. Off: a neutral document.'] },
        aiGenerated: { label: [`${NS}.field_ai_generated`, 'Written by AI'], hint: [`${NS}.hint_ai_generated`, 'On when the text comes from an AI step: the file then carries the organisation’s AI marking.'] },
        attachToRecordId: { hint: [`${NS}.hint_attach_record`, 'With a file column, everyone who can read this record can download the file. Without, only the app owner can.'] },
        attachToFieldKey: { hint: [`${NS}.hint_attach_field`, 'The file column of that record. Set both or neither.'] },
        resultVar: { hint: [`${NS}.hint_result_var`, 'The variable that gets the file, for a download, a preview or an e-mail attachment.'] },
    },
};

export default entry;
