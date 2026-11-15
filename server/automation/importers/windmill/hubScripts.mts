/**
 * The Nextcloud scripts of the Windmill Hub to Bee Flow actions (PLAN B3
 * hubScripts.mts, appendix 7.2, research 06 §C.7).
 *
 * Matched on the SLUG of `hub/<version>/nextcloud/<slug>`, never on the
 * number: the number is a version id that differs per Hub release
 * (research 01 §2.4). The slug is compared without punctuation, so
 * `nextcloud_tables:_get_all_columns_of_a_table` and a future
 * `get_all_columns_of_a_table` find the same entry.
 *
 * The Windmill inputs that carry the Nextcloud connection (`nextcloud`,
 * `ncResource`, …) are dropped: Bee Flow's connector signs the call. An input
 * with no counterpart is listed (`leftover`) so the report and the AI
 * checklist can name it. The result of a Hub script is re-shaped onto the Bee
 * Flow output where the two shapes are known (`reshape`); a reference into a
 * result whose shape is not known becomes an AI item, never a guessed path.
 *
 * Hub scripts of other apps go to the AI builder in v1.
 */

import type { WmInput, WmNode } from './ir.mts';
import type { Reshape, ScriptPlan } from './plan.mts';
import { asField, under } from './plan.mts';
import { findTitleLiteral, rawPath } from './jsShapes.mts';
import { AI_STEP_IMAGES_FIELD, READ_FILE_FORM_FIELDS_PARAM, READ_FILE_IMAGE_HANDLE_FIELD, TOOL } from './targetNames.mts';
import type { Capabilities } from './capabilities.mts';

const CONNECTION_INPUTS = new Set(['nextcloud', 'ncresource', 'nextcloudresource', 'useappapiauth', 'resource', 'auth']);

interface ToolEntry {
    tool: string;
    /** Bee Flow parameters of the tool. */
    params: string[];
    /** Windmill input name (lower case) to Bee Flow parameter; null drops it. */
    map?: Record<string, string | null>;
    reshape: Reshape | null;
    status: 'mapped' | 'pattern';
    repick?: string[];
    notes?: string[];
}

const TOOLS: Record<string, ToolEntry> = {
    notification: {
        tool: 'nextcloud_notifications_send', params: ['userId', 'shortMessage', 'longMessage'],
        map: { notificationuserid: 'userId', subject: 'shortMessage', message: 'longMessage', subjectparameters: null, messageparameters: null },
        reshape: null, status: 'mapped',
    },
    talkSend: { tool: 'nextcloud_talk_send_message', params: ['token', 'message'], map: { roomtoken: 'token', room: 'token', chattoken: 'token' }, reshape: null, status: 'mapped', repick: ['the Talk room'] },
    talkRooms: { tool: 'nextcloud_talk_list_rooms', params: [], reshape: null, status: 'mapped' },
    tablesList: { tool: 'nextcloud_tables_list', params: [], reshape: under('tables'), status: 'mapped' },
    tablesColumns: { tool: 'nextcloud_tables_list_columns', params: ['tableId'], map: { tableid: 'tableId' }, reshape: under('columns'), status: 'mapped', repick: ['the table'] },
    readFile: { tool: 'nextcloud_read_file', params: ['path'], map: { filepath: 'path' }, reshape: asField('content'), status: 'mapped', notes: ['Bee Flow reads the TEXT of the file (a PDF, a document, a sheet), not its bytes.'] },
    uploadFile: { tool: 'nextcloud_upload_file', params: ['path', 'content'], map: { filepath: 'path', data: 'content', filecontent: 'content' }, reshape: null, status: 'mapped' },
    listFiles: { tool: 'nextcloud_list_files', params: ['path'], map: { folder: 'path', folderpath: 'path' }, reshape: null, status: 'mapped' },
    calendarCreate: {
        tool: 'nextcloud_calendar_create_event', params: ['calendar', 'summary', 'start', 'end', 'description', 'location', 'attendees'],
        map: { calendarid: 'calendar', calendarname: 'calendar', title: 'summary', name: 'summary', startdate: 'start', enddate: 'end' },
        reshape: null, status: 'pattern', repick: ['the calendar'],
    },
    calendarList: { tool: 'nextcloud_calendar_list', params: [], reshape: null, status: 'mapped' },
    formSubmission: {
        tool: 'nextcloud_forms_get_submissions', params: ['formId', 'submissionId'], map: { formid: 'formId', submissionid: 'submissionId' },
        reshape: (segs) => {
            if (segs[0]?.v !== 'submission') return null;
            const rest = segs.slice(1);
            if (rest[0] && (rest[0].v === 'userId' || rest[0].v === 'id' || rest[0].v === 'formId')) {
                return { segs: [{ kind: 'name', v: 'submissions' }, { kind: 'index', v: 0 }, ...rest] };
            }
            return null;
        },
        status: 'mapped',
        notes: ['Bee Flow returns the answers keyed by question text (answers["Question"]), not as a list with questionName.'],
    },
};

/** Slug keywords (no punctuation, lower case) to the entry they select. First match wins. */
const SLUG_RULES: Array<[string[], string]> = [
    [['approvallink'], 'special:approval'], [['approvelinks'], 'special:approval'],
    [['pathfromfileid'], 'special:pathFromFileid'],
    [['sendanotification'], 'notification'], [['notification'], 'notification'],
    [['talk', 'send'], 'talkSend'], [['talk', 'rooms'], 'talkRooms'],
    [['columns'], 'tablesColumns'], [['editarow'], 'special:editRow'], [['editrow'], 'special:editRow'],
    [['createarow'], 'special:createRow'], [['createrow'], 'special:createRow'],
    [['tables', 'list'], 'tablesList'], [['listtables'], 'tablesList'],
    [['getfilecontent'], 'readFile'], [['upload'], 'uploadFile'], [['listfiles'], 'listFiles'],
    [['createshare'], 'special:createShare'], [['groupfolder'], 'special:groupFolder'],
    [['listcalendars'], 'calendarList'], [['calendar', 'create'], 'calendarCreate'], [['createevent'], 'calendarCreate'],
    [['formsubmission'], 'formSubmission'],
    [['gettaskprocessing'], 'special:dropTask'], [['taskprocessing'], 'special:aiTask'],
    [['summarize'], 'special:summarize'], [['summarise'], 'special:summarize'], [['translate'], 'special:translate'],
    [['analyzeimage'], 'special:analyzeImage'], [['readpdfform'], 'special:readPdfForm'], [['fillforms'], 'special:fillForms'],
];

/** `hub/<n>/<app>/<slug>` into its parts, or null. */
export function parseHubPath(path: string | undefined): { app: string; slug: string } | null {
    if (!path || !path.startsWith('hub/')) return null;
    const parts = path.split('/');
    if (parts.length < 4) return null;
    return { app: parts[2], slug: parts.slice(3).join('/') };
}

export function slugKey(slug: string): string {
    let out = '';
    for (const ch of slug.toLowerCase()) if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) out += ch;
    return out;
}

export function hubEntryFor(slug: string): string | null {
    const key = slugKey(slug);
    for (const [words, entry] of SLUG_RULES) if (words.every((w) => key.includes(w))) return entry;
    return null;
}

/** The plan for a `script` module that points at the Hub. */
export function planHub(node: WmNode, caps: Capabilities): ScriptPlan {
    const hub = parseHubPath(node.scriptPath);
    if (!hub) return { kind: 'ai', reason: 'The script path is not a Hub path.' };
    if (hub.app !== 'nextcloud') return { kind: 'ai', reason: `Hub scripts of "${hub.app}" are converted by the AI builder.` };
    const entry = hubEntryFor(hub.slug);
    if (!entry) return { kind: 'ai', reason: `The Nextcloud Hub script "${hub.slug}" is not in the conversion table.` };
    if (entry.startsWith('special:')) return planSpecial(entry.slice('special:'.length), node, caps);
    return planTool(TOOLS[entry], node.inputs);
}

/**
 * Hub scripts of the old Flow ExApp signed in with three inputs: the
 * resource, `userId` and `useAppApiAuth`. There `userId` is part of the
 * connection, not a parameter.
 */
function isConnectionInput(lower: string, wm: Record<string, WmInput>): boolean {
    if (CONNECTION_INPUTS.has(lower)) return true;
    return lower === 'userid' && Object.keys(wm).some((k) => k.toLowerCase() === 'useappapiauth');
}

function planTool(entry: ToolEntry, wm: Record<string, WmInput>, reason = 'Known Nextcloud Hub script.'): ScriptPlan {
    const inputs: Record<string, WmInput> = {};
    const leftover: string[] = [];
    for (const [name, input] of Object.entries(wm)) {
        const lower = name.toLowerCase();
        if (isConnectionInput(lower, wm)) continue;
        const mapped = entry.map && lower in entry.map ? entry.map[lower] : (entry.params.includes(name) ? name : undefined);
        if (mapped === null) continue;
        if (mapped === undefined) { if (!isEmptyInput(input)) leftover.push(name); continue; }
        inputs[mapped] = input;
    }
    return {
        kind: 'tool', tool: entry.tool, inputs, reshape: entry.reshape, status: entry.status,
        confidence: leftover.length ? 'medium' : 'high', reason,
        ...(leftover.length ? { leftover } : {}), ...(entry.notes ? { notes: entry.notes } : {}), ...(entry.repick ? { repick: entry.repick } : {}),
    };
}

function isEmptyInput(input: WmInput): boolean {
    return input.type === 'static' && (input.value === null || input.value === '' || input.value === undefined);
}

function textInput(wm: Record<string, WmInput>, names: string[]): WmInput | undefined {
    for (const n of names) for (const [k, v] of Object.entries(wm)) if (k.toLowerCase() === n) return v;
    return undefined;
}

type Special = (node: WmNode, caps: Capabilities) => ScriptPlan;

const SPECIALS: Record<string, Special> = {
    approval: (node) => ({ kind: 'approval', reason: 'An approve_links link becomes a Bee Flow approval.', prompt: textInput(node.inputs, ['description', 'message', 'title']) }),
    pathFromFileid: planPathFromFileid,
    editRow: planEditRow,
    createRow: () => ({ kind: 'ai', reason: 'The row is keyed by column id; Bee Flow writes rows by column title, so the columns must be matched in this Nextcloud.', title: 'Map the table row' }),
    createShare: planShare,
    groupFolder: () => ({ kind: 'unsupported', reason: 'Bee Flow has no action that creates a group folder.' }),
    dropTask: () => ({ kind: 'drop', reason: 'A Bee Flow AI step answers at once; there is no task to fetch afterwards.' }),
    aiTask: (node) => aiStep(node, 'Do the task described in the input.', 'A Nextcloud AI task becomes a Bee Flow AI step.'),
    summarize: (node) => aiStep(node, 'Summarise the text in the input.', 'Summarising becomes a Bee Flow AI step.'),
    translate: (node) => aiStep(node, 'Translate the text in the input into the requested language.', 'Translating becomes a Bee Flow AI step.'),
    analyzeImage: planAnalyzeImage,
    readPdfForm: planReadPdfForm,
    fillForms: () => ({ kind: 'ai', reason: 'Filling the user\'s own PDF or ODT form is not possible; the builder can rebuild the template as a Bee Flow document.', title: 'Fill the document' }),
};

function planSpecial(name: string, node: WmNode, caps: Capabilities): ScriptPlan {
    const fn = SPECIALS[name];
    return fn ? fn(node, caps) : { kind: 'ai', reason: 'Unknown Hub script.' };
}

function aiStep(node: WmNode, prompt: string, reason: string): ScriptPlan {
    const inputs: Record<string, WmInput> = {};
    for (const [k, v] of Object.entries(node.inputs)) if (!CONNECTION_INPUTS.has(k.toLowerCase()) && !isEmptyInput(v)) inputs[k] = v;
    return { kind: 'ai_step', prompt, inputs, reason, confidence: 'medium', notes: ['This ran on the Nextcloud AI provider; it now runs on the AI model this organisation set up.'] };
}

/**
 * Analyze Image: the images are named by file id and come from a list, so the
 * steps (file info per id, read file per path, one AI step) are wired by the
 * builder from a checklist item that names the target. With images to AI on,
 * the AI step is shown the pictures (`images` bound to each read's
 * `sourceHandle`); with it off, it works from the text read from them (OCR).
 */
function planAnalyzeImage(_node: WmNode, caps: Capabilities): ScriptPlan {
    if (caps.imageAi) {
        return {
            kind: 'ai', title: 'Analyse the images',
            reason: `Analyze Image becomes "${TOOL.readFile}" for each image and one AI step that is shown the pictures: bind its \`${AI_STEP_IMAGES_FIELD}\` to the \`${READ_FILE_IMAGE_HANDLE_FIELD}\` of each read, and use a model that reads images.`,
        };
    }
    return { kind: 'ai', reason: 'Images to AI is off for this organisation, so the builder reads the text of the images (OCR) and works from that.', title: 'Analyse the images' };
}

function planPathFromFileid(node: WmNode, caps: Capabilities): ScriptPlan {
    const fileid = textInput(node.inputs, ['fileid', 'fileId'.toLowerCase()]);
    const raw = fileid && fileid.type === 'javascript' ? rawPath(fileid.expr) : null;
    if (raw === 'flow_input.event.node.id') {
        return { kind: 'alias', path: 'trigger.output.path', reason: 'The file is the one that started the run: its path is in the trigger.' };
    }
    if (!caps.fileInfo) return { kind: 'ai', reason: 'Looking a file up by its id needs the "file info" action.', title: 'Find the file by id' };
    return {
        kind: 'tool', tool: TOOL.fileInfo, inputs: fileid ? { fileId: fileid } : {}, reshape: asField('path'),
        status: 'mapped', confidence: 'high', reason: 'Path from file id becomes the file info action.',
    };
}

function planEditRow(node: WmNode): ScriptPlan {
    const rowId = textInput(node.inputs, ['rowid']);
    const value = textInput(node.inputs, ['value']);
    const columnId = textInput(node.inputs, ['columnid']);
    const title = columnId && columnId.type === 'javascript' ? findTitleLiteral(columnId.expr) : null;
    if (!rowId || !value || !title) {
        return { kind: 'ai', reason: 'The column is named by its id; Bee Flow updates a row by column title, so pick the column in this Nextcloud.', title: 'Update the table row' };
    }
    return {
        kind: 'tool', tool: 'nextcloud_tables_update_row', inputs: { rowId, values: value }, wrapValuesAs: title, tableFromContext: true,
        reshape: under('row'), status: 'pattern', confidence: 'medium', reason: `The column "${title}" is found by its title.`, repick: ['the table'],
    };
}

const SHARE_TOOLS: Record<number, { tool: string; with: string }> = {
    0: { tool: 'nextcloud_share_with_user', with: 'shareWith' },
    1: { tool: 'nextcloud_share_with_group', with: 'shareWith' },
    3: { tool: 'nextcloud_create_share', with: '' },
    4: { tool: 'nextcloud_share_by_email', with: 'shareWith' },
    7: { tool: 'nextcloud_share_with_team', with: 'teamId' },
};

function planShare(node: WmNode): ScriptPlan {
    const type = textInput(node.inputs, ['sharetype']);
    const n = type && type.type === 'static' ? Number(type.value) : NaN;
    const target = SHARE_TOOLS[n];
    if (!target) return { kind: 'ai', reason: 'The share type is not a fixed value, so the share action cannot be chosen.', title: 'Choose the share' };
    const inputs: Record<string, WmInput> = {};
    const path = textInput(node.inputs, ['path']);
    if (path) inputs.path = path;
    const withInput = textInput(node.inputs, ['sharewith']);
    if (target.with && withInput) inputs[target.with] = withInput;
    const settings = textInput(node.inputs, ['settings']);
    const notes = settings && !isEmptyInput(settings) ? ['The share settings (note, label, password) were not carried over; set them on the step.'] : [];
    return { kind: 'tool', tool: target.tool, inputs, reshape: null, status: 'pattern', confidence: notes.length ? 'medium' : 'high', reason: `Share type ${n} selects this share action.`, ...(notes.length ? { notes } : {}) };
}

function planReadPdfForm(node: WmNode, caps: Capabilities): ScriptPlan {
    if (!caps.readFileFormFields) return { kind: 'ai', reason: 'Reading the fields of a PDF form needs the form-field option of "read file".', title: 'Read the PDF form' };
    const path = textInput(node.inputs, ['path', 'pdfpath', 'filepath']);
    return {
        kind: 'tool', tool: TOOL.readFile, inputs: path ? { path } : {}, fixed: { [READ_FILE_FORM_FIELDS_PARAM]: true },
        reshape: null, status: 'pattern', confidence: 'medium', reason: 'Read PDF Form becomes "read file" with its form fields.',
    };
}
