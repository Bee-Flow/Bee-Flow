/**
 * Tool definitions (OpenAI function-calling format) and limits for the Frappe
 * CRM integration. Pure data: the executor is frappeCrmTools.mts.
 *
 * The tool set reads and writes the CRM record types of Frappe CRM only
 * (DOCTYPES below); there is no delete and no tool that takes an arbitrary
 * DocType. frappeCrmTools.test.js asserts both.
 */

import { envInt } from './frappeCrmClient.mts';

export const DEFAULT_LIMIT = 20;
export const DEFAULT_MAX_PAGE_SIZE = 500;
export const DEFAULT_MAX_OUTPUT_CHARS = 60_000;
export const MAX_TEXT_CHARS = 4000;

/** Records per call. Infinity when FRAPPE_CRM_MAX_PAGE_SIZE is 0 (unlimited). */
export function getMaxPageSize(): number {
    const n = envInt('FRAPPE_CRM_MAX_PAGE_SIZE', DEFAULT_MAX_PAGE_SIZE);
    return n === 0 ? Infinity : n;
}

/** Characters of JSON one result may hold. Infinity when FRAPPE_CRM_MAX_OUTPUT_CHARS is 0 (unlimited). */
export function getMaxOutputChars(): number {
    const n = envInt('FRAPPE_CRM_MAX_OUTPUT_CHARS', DEFAULT_MAX_OUTPUT_CHARS);
    return n === 0 ? Infinity : n;
}

/** The only DocTypes the tools touch. */
export const DOCTYPES = Object.freeze({
    lead: 'CRM Lead',
    deal: 'CRM Deal',
    contact: 'Contact',
    organization: 'CRM Organization',
    task: 'CRM Task',
    note: 'FCRM Note',
    lead_status: 'CRM Lead Status',
    deal_status: 'CRM Deal Status',
});

export type DocKind = keyof typeof DOCTYPES;

interface ToolDef {
    type: 'function';
    function: { name: string; description: string; parameters: Record<string, unknown> };
}

function fn(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolDef {
    return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}

const str = (description: string) => ({ type: 'string', description });
const num = (description: string) => ({ type: 'number', description });

const LIMIT = { type: 'integer', description: `Maximum number of records (default ${DEFAULT_LIMIT}, capped by the server setting FRAPPE_CRM_MAX_PAGE_SIZE)` };
const OFFSET = { type: 'integer', description: 'Number of records to skip, for the next page (default 0)' };
const ORDER = { type: 'string', enum: ['modified desc', 'modified asc', 'creation desc', 'creation asc'], description: 'Sort order (default "modified desc", the most recently changed first)' };
const FIELDS = { type: 'array', items: { type: 'string' }, description: 'Field names to return instead of the default set (lower-case Frappe field names, such as "lead_name" or a custom field "custom_region"). "name" is always included.' };
const SEARCH = (what: string) => str(`Text to look for in ${what} (contains, case-insensitive)`);
const RECORD_TYPE = { type: 'string', enum: ['lead', 'deal'], description: 'Whether the record is a lead or a deal' };
const RECORD_NAME = str('The record name (ID) of the lead or deal, such as CRM-LEAD-2025-00001 or CRM-DEAL-2025-00001');

const LEAD_FIELDS = {
    first_name: str('First name of the person'),
    last_name: str('Last name'),
    email: str('E-mail address'),
    mobile_no: str('Mobile number'),
    phone: str('Phone number'),
    organization: str('Organisation (company) name, as text'),
    job_title: str('Job title'),
    website: str('Website'),
    status: str('Lead status, one of the names from frappe_crm_list_statuses (record_type "lead"), such as New or Contacted'),
    source: str('Lead source (a CRM Lead Source name)'),
    industry: str('Industry (a CRM Industry name)'),
    territory: str('Territory (a CRM Territory name)'),
    lead_owner: str('User (e-mail) who owns the lead'),
    no_of_employees: { type: 'string', enum: ['1-10', '11-50', '51-200', '201-500', '501-1000', '1000+'], description: 'Number of employees' },
    annual_revenue: num('Annual revenue'),
};

const DEAL_FIELDS = {
    organization: str('Organisation, the name of a CRM Organization record (frappe_crm_list_organizations)'),
    status: str('Deal status, one of the names from frappe_crm_list_statuses (record_type "deal"), such as Qualification or Won'),
    deal_value: num('Deal value'),
    expected_deal_value: num('Expected deal value'),
    expected_closure_date: str('Expected closure date, YYYY-MM-DD'),
    closed_date: str('Closed date, YYYY-MM-DD'),
    probability: num('Probability in percent (0-100)'),
    next_step: str('Next step'),
    deal_owner: str('User (e-mail) who owns the deal'),
    lead: str('Record name of the lead this deal came from'),
    contact: str('Record name of the primary Contact'),
    source: str('Source (a CRM Lead Source name)'),
    territory: str('Territory (a CRM Territory name)'),
    lost_reason: str('Lost reason (a CRM Lost Reason name), when the status is Lost'),
    lost_notes: str('Notes on why the deal was lost'),
};

const TASK_FIELDS = {
    title: str('Title of the task'),
    description: str('Description (plain text or simple HTML)'),
    status: { type: 'string', enum: ['Backlog', 'Todo', 'In Progress', 'Done', 'Canceled'], description: 'Status (default Todo)' },
    priority: { type: 'string', enum: ['Low', 'Medium', 'High'], description: 'Priority' },
    due_date: str('Due date and time, YYYY-MM-DD or YYYY-MM-DD HH:MM:SS'),
    start_date: str('Start date, YYYY-MM-DD'),
    assigned_to: str('User (e-mail) the task is assigned to'),
    record_type: { ...RECORD_TYPE, description: 'Link the task to a lead or a deal (optional, with record_name)' },
    record_name: str('Record name of the lead or deal to link the task to (optional, with record_type)'),
};

/** Fields a write may set, per kind: everything else in the arguments is ignored. */
export const WRITABLE_FIELDS: Readonly<Record<'lead' | 'deal' | 'task' | 'note', readonly string[]>> = Object.freeze({
    lead: Object.freeze(Object.keys(LEAD_FIELDS)),
    deal: Object.freeze(Object.keys(DEAL_FIELDS)),
    task: Object.freeze(Object.keys(TASK_FIELDS).filter((k) => k !== 'record_type' && k !== 'record_name')),
    note: Object.freeze(['title', 'content']),
});

export const FRAPPE_CRM_TOOLS: ToolDef[] = [
    fn('frappe_crm_list_leads',
        'List or search leads in Frappe CRM. Filter by status or owner, search by name, e-mail or organisation. Returns name (the record ID), lead_name, organization, email, status, lead_owner and modified unless fields says otherwise.',
        { search: SEARCH('the lead name, e-mail address and organisation'), status: str('Only leads with this status'), lead_owner: str('Only leads owned by this user (e-mail)'), fields: FIELDS, order_by: ORDER, limit: LIMIT, offset: OFFSET }),
    fn('frappe_crm_get_lead', 'Get one lead with all its fields by its record name (such as CRM-LEAD-2025-00001).', { name: str('Record name of the lead') }, ['name']),
    fn('frappe_crm_list_deals',
        'List or search deals in Frappe CRM. Filter by status, organisation or owner, search by organisation or contact name. Returns name (the record ID), organization, status, deal_value, expected_closure_date, deal_owner and modified unless fields says otherwise.',
        { search: SEARCH('the organisation, the lead name and the e-mail address'), status: str('Only deals with this status'), organization: str('Only deals of this organisation (CRM Organization name)'), deal_owner: str('Only deals owned by this user (e-mail)'), fields: FIELDS, order_by: ORDER, limit: LIMIT, offset: OFFSET }),
    fn('frappe_crm_get_deal', 'Get one deal with all its fields by its record name (such as CRM-DEAL-2025-00001).', { name: str('Record name of the deal') }, ['name']),
    fn('frappe_crm_list_contacts',
        'List or search contacts (people) in Frappe CRM. Returns name, full_name, email_id, mobile_no, company_name and modified unless fields says otherwise.',
        { search: SEARCH('the name, e-mail address and company'), fields: FIELDS, order_by: ORDER, limit: LIMIT, offset: OFFSET }),
    fn('frappe_crm_get_contact', 'Get one contact with all its fields by its record name.', { name: str('Record name of the contact') }, ['name']),
    fn('frappe_crm_list_organizations',
        'List or search organisations (companies) in Frappe CRM. Returns name, organization_name, website, industry, territory and modified unless fields says otherwise.',
        { search: SEARCH('the organisation name and website'), fields: FIELDS, order_by: ORDER, limit: LIMIT, offset: OFFSET }),
    fn('frappe_crm_get_organization', 'Get one organisation with all its fields by its record name (usually the organisation name).', { name: str('Record name of the organisation') }, ['name']),
    fn('frappe_crm_list_tasks',
        'List tasks in Frappe CRM, optionally only those of one lead or deal. Returns name, title, status, priority, due_date, assigned_to, reference_doctype, reference_docname and modified.',
        { record_type: { ...RECORD_TYPE, description: 'Only tasks of a lead or of a deal (with record_name)' }, record_name: str('Record name of the lead or deal (with record_type)'), status: TASK_FIELDS.status, assigned_to: str('Only tasks assigned to this user (e-mail)'), order_by: ORDER, limit: LIMIT, offset: OFFSET }),
    fn('frappe_crm_list_notes', 'List the notes of one lead or deal, newest first. Returns name, title, content, owner and modified.',
        { record_type: RECORD_TYPE, record_name: RECORD_NAME, limit: LIMIT, offset: OFFSET }, ['record_type', 'record_name']),
    fn('frappe_crm_list_statuses', 'List the statuses a lead or a deal can have, in their pipeline order (name, type such as Open, Won or Lost, and for deals the probability). Use the names as status values.',
        { record_type: RECORD_TYPE }, ['record_type']),
    fn('frappe_crm_create_lead', 'Create a lead in Frappe CRM. first_name is required. Search with frappe_crm_list_leads first so you do not create a duplicate. Returns the new record name.',
        LEAD_FIELDS, ['first_name']),
    fn('frappe_crm_update_lead', 'Change fields of an existing lead, for example its status. Only the fields you pass are changed.',
        { name: str('Record name of the lead'), ...LEAD_FIELDS }, ['name']),
    fn('frappe_crm_create_deal', 'Create a deal in Frappe CRM. Pass the organisation as the name of an existing CRM Organization. When status is left out the CRM picks its default. Returns the new record name.',
        DEAL_FIELDS),
    fn('frappe_crm_update_deal', 'Change fields of an existing deal, for example its status or value. Only the fields you pass are changed.',
        { name: str('Record name of the deal'), ...DEAL_FIELDS }, ['name']),
    fn('frappe_crm_add_note', 'Add a note to a lead or a deal.',
        { record_type: RECORD_TYPE, record_name: RECORD_NAME, title: str('Title of the note'), content: str('Text of the note (plain text or simple HTML)') }, ['record_type', 'record_name', 'title']),
    fn('frappe_crm_create_task', 'Create a task in Frappe CRM, optionally linked to a lead or a deal. Returns the new record name.',
        TASK_FIELDS, ['title']),
];

export const FRAPPE_CRM_TOOL_NAMES: ReadonlySet<string> = new Set(FRAPPE_CRM_TOOLS.map((t) => t.function.name));

/** The tools that change data in the CRM. */
export const FRAPPE_CRM_WRITE_TOOLS: ReadonlySet<string> = new Set([
    'frappe_crm_create_lead', 'frappe_crm_update_lead', 'frappe_crm_create_deal', 'frappe_crm_update_deal',
    'frappe_crm_add_note', 'frappe_crm_create_task',
]);
