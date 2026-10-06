/**
 * Display helpers — turn machine identifiers (tool names, step refs, field
 * paths, rule expressions) into human-readable text. Originally canvas-only;
 * the Condition node's field picker uses `humanizeFieldKey` in the inspector too,
 * because a non-technical author should read "Subject", never `item.subject`.
 */
import { formatPath, parsePath } from '@shared/expr/path.mjs';
import { fieldShape, singularKey } from '@shared/expr/rules.mjs';
import { pathLabelParts } from '../../../../utils/bindingHelpers';
import { parseRefTokens, resolveChipLabel } from '../mapping/refTokens';
import { inferType, isUnaryOp, labelFor, parseExprToRows } from '../utils/conditionModel';

// Step labels by id live in runStepLabels.ts; their names stay importable from here.
export { buildRunStepLabelMap, buildRunStepMap, buildStepLabelMap, runStepLabel } from './runStepLabels';

// Hand-curated proper-noun casing so 'gmail' renders as 'Gmail' instead
// of 'Gmail' is fine but 'github' should render as 'GitHub', 'youtrack'
// as 'YouTrack', etc. Anything not listed falls through to title-case.
const PROPER_CASE = {
    gmail: 'Gmail',
    github: 'GitHub',
    youtrack: 'YouTrack',
    afas: 'AFAS',
    nmbrs: 'NMBRS',
    nextcloud: 'Nextcloud',
    google: 'Google',
    docs: 'Docs',
    sheets: 'Sheets',
    slides: 'Slides',
    drive: 'Drive',
    calendar: 'Calendar',
    contacts: 'Contacts',
    keep: 'Keep',
    groups: 'Groups',
    maps: 'Maps',
    outlook: 'Outlook',
    onedrive: 'OneDrive',
    ms: 'Microsoft',
    fireflies: 'Fireflies',
    elevenlabs: 'ElevenLabs',
    linkedin: 'LinkedIn',
    signrequest: 'SignRequest',
    n8n: 'n8n',
    kb: 'Knowledge Base',
    deck: 'Deck',
    talk: 'Talk',
    tasks: 'Tasks',
    notes: 'Notes',
    mail: 'Mail',
    activity: 'Activity',
    notifications: 'Notifications',
    status: 'Status',
    tts: 'TTS',
    sfx: 'SFX',
    ai: 'AI',
    pdf: 'PDF',
};

function pretty(token) {
    if (!token) return '';
    const lower = token.toLowerCase();
    if (PROPER_CASE[lower]) return PROPER_CASE[lower];
    return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * Convert a tool name to a friendly subtitle. Splits on underscores,
 * applies proper-noun casing, joins with spaces.
 *
 *   gmail_send                  → 'Gmail Send'
 *   nextcloud_tasks_create      → 'Nextcloud Tasks Create'
 *   nextcloud_notifications_send → 'Nextcloud Notifications Send'
 *   generate_image              → 'Generate Image'
 *   elevenlabs_tts              → 'ElevenLabs TTS'
 */
export function humanizeToolName(toolName) {
    if (!toolName || typeof toolName !== 'string') return '';
    return toolName.split('_').filter(Boolean).map(pretty).join(' ');
}

/**
 * An integration action as a person reads it: "Gmail: Search" when the tool
 * catalog knows it, "Gmail Search" when it doesn't. The raw tool id
 * (`gmail_search`) is never the right thing to put in front of someone — it
 * was what the node-config header showed for any unnamed action (BFSF-333).
 */
export function actionDisplayLabel(tool, catalog = null) {
    const name = String(tool || '');
    if (!name) return '';
    for (const app of (catalog?.apps || [])) {
        const action = (app?.actions || []).find(a => a?.name === name);
        if (!action) continue;
        const appLabel = app.label || action.integrationLabel || '';
        const actionLabel = action.label || humanizeToolName(name);
        return appLabel ? `${appLabel}: ${actionLabel}` : actionLabel;
    }
    return humanizeToolName(name);
}

/**
 * A data field's key rendered as a plain English name — `subject` → "Subject",
 * `from_email` → "From email", `messageId` → "Message id", `htmlUrl` → "HTML url".
 *
 * Used wherever a non-technical user picks a field: they should read the name of
 * the thing ("Subject"), never its path (`item.subject`). Reuses the same
 * proper-noun table as the tool-name humanizer, so `pdf` stays "PDF".
 */
export function humanizeFieldKey(key) {
    const raw = String(key || '').trim();
    if (!raw) return '';
    const words = raw
        .replace(/[_\-.]+/g, ' ')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')   // camelCase → camel Case
        .split(/\s+/)
        .filter(Boolean);
    if (!words.length) return raw;
    return words
        .map((w, i) => {
            const known = PROPER_CASE[w.toLowerCase()];
            if (known) return known;
            // Only the first word is capitalised — "From email", not "From Email";
            // sentence case reads as a label, title case reads as a heading.
            return i === 0 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase();
        })
        .join(' ');
}

/** "1st", "2nd", "last" — an index the way a person counts. */
function ordinalLabel(index) {
    if (index === -1) return 'last';
    const n = Math.abs(index < 0 ? index : index + 1);
    const v = n % 100;
    const suffix = (v >= 11 && v <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] || 'th';
    return index < 0 ? `${n}${suffix} from last` : `${n}${suffix}`;
}

/** Text that is no path: its last dotted segment, brackets dropped. */
function lastSegmentLabel(text) {
    const seg = String(text).replace(/\[[^\]]*\]/g, '').split('.').filter(Boolean).pop();
    return seg ? humanizeFieldKey(seg) : '';
}

/**
 * The readable name of a field path, the way its pill names it (the pills
 * call this too, through refTokens.fieldTailLabel): the field's own key,
 * humanised — `fields["Story Points"]` reads "Story points",
 * `headers[name="Subject"].value` "Subject". A generic key gets the key that
 * says whose it is (`from.emailAddress.address` → "From ▸ Address", so a
 * sender's and a recipient's address read differently), and an index right
 * after the key says which one (`items[0]` → "Items ▸ 1st"). Wildcards and
 * indexes further up are dropped; the exact path stays on the pill's tooltip
 * (BFSF-330).
 */
export function humanizeFieldTail(fieldPath) {
    const tail = String(fieldPath ?? '').trim();
    if (!tail) return '';
    const parts = pathLabelParts(tail);
    if (!parts || !parts.leaf) return parts?.index != null ? ordinalLabel(parts.index) : lastSegmentLabel(tail);
    const name = humanizeFieldKey(parts.leaf) || parts.leaf;
    const head = parts.parent ? `${humanizeFieldKey(parts.parent) || parts.parent} ▸ ${name}` : name;
    return parts.index == null ? head : `${head} ▸ ${ordinalLabel(parts.index)}`;
}

/**
 * Replace `steps.<id>.output.<path>` references inside an expression
 * with a human marker `‹Step Label›.path`. Quoted strings are left
 * untouched so we don't mangle literal strings that happen to contain
 * the word `steps`.
 *
 *   steps.ai_a9afb3.output.urgentie == "hoog"
 *     →  ‹Classificeer document›.urgentie == "hoog"
 *
 * If `stepLabelById` is missing or has no entry for an id, the original
 * id is preserved so the user can still trace it.
 */
export function humanizeExpression(expr, stepLabelById = null) {
    if (!expr || typeof expr !== 'string') return '';
    return expr
        .replace(
            /steps\.([A-Za-z0-9_]+)\.output(?:\.([A-Za-z0-9_.[\]]+))?/g,
            (_, stepId, path) => {
                const label = stepLabelById?.get?.(stepId) || stepId;
                return path ? `‹${label}›.${path}` : `‹${label}›`;
            },
        )
        .replace(
            /\bloop\.([A-Za-z0-9_]+)(?:\.([A-Za-z0-9_.[\]]+))?/g,
            (_, itemVar, path) => {
                const head = itemVar ? `‹Each ${itemVar}›` : '‹Each item›';
                return path ? `${head}.${path}` : head;
            },
        )
        .replace(
            /\btrigger(?:\.([A-Za-z0-9_.[\]]+))?/g,
            (_, path) => (path ? `‹Trigger›.${path}` : '‹Trigger›'),
        );
}

/**
 * A TEMPLATE string (`Hello {{steps.code_1.output.result.text}}`) as the card
 * subtitle shows it: each reference the way the panel's chip names it, "Code ▸
 * Text", and nothing else rewritten. References that sit back to back (an old
 * drop that glued them) are separated with " · " so they read as a list
 * instead of one word. `humanizeExpression` is for bare expressions: run over
 * a template it left `{{‹Code›.result.text}}{{‹Code›.result.number}}` behind.
 *
 * Display-only; the stored string is never touched.
 *
 * @param {string|null|undefined} text
 * @param {Map<string, string>|null} [stepLabelById]
 * @returns {string}
 */
export function humanizeTemplate(text, stepLabelById = null) {
    if (!text || typeof text !== 'string') return '';
    const tokens = parseRefTokens(text, { mode: 'fixed' });
    if (!tokens.some(t => t.type === 'ref')) return text;
    let out = '';
    let prevRef = false;
    tokens.forEach((tok, i) => {
        if (tok.type === 'literal') {
            // Only whitespace between two references is a separator, not prose.
            const between = prevRef && tokens[i + 1]?.type === 'ref' && !tok.text.trim();
            out += between ? ' · ' : tok.text;
            prevRef = false;
            return;
        }
        const { name, suffix } = resolveChipLabel(tok, stepLabelById);
        const tail = suffix ? humanizeFieldTail(suffix) : '';
        out += `${prevRef ? ' · ' : ''}${tail ? `${name} ▸ ${tail}` : name}`;
        prevRef = true;
    });
    return out;
}

// ── Rules as sentences (canvas cards, Suggest outputs, the run panel) ──

/** The English of `condition_node.file_type.<key>` (server/i18n/defaults/en/condition_node.js). */
const FILE_TYPE_EN = new Map(Object.entries({
    pdf: 'PDF', word: 'Word', excel: 'Excel or CSV', powerpoint: 'PowerPoint', image: 'Image',
    text: 'Text', archive: 'Archive (zip)', audio: 'Audio', video: 'Video', other: 'Other',
}));
const QUANTIFIER_EN = new Map([['any', 'any {name}'], ['every', 'every {name}'], ['none', 'no {name}']]);
const TRIVIAL_RULES = new Set(['', 'true', 'false']);
// Where the field's own part of a path starts, after the root that says whose it is.
const ROOT_SKIP = new Map([['item', 1], ['loop', 2], ['vars', 1]]);

const say = (t, key, en, vars = {}) => (t ? t(key, en, vars) : en.replace(/\{(\w+)\}/g, (_, v) => String(vars[v] ?? '')));

/**
 * A rule's field the way the pills name it (humanizeFieldTail): the part
 * after `item` ("From ▸ Email"), and for a whole-run rule the step's label in
 * front ("Classify ▸ Urgency") when the map knows it.
 */
function fieldName(path, stepLabelById) {
    const tokens = parsePath(path);
    if (!tokens?.length) return humanizeFieldTail(path);
    const root = String(tokens[0].key);
    const from = fieldStart(root, tokens);
    const tail = tokens.length > from ? humanizeFieldTail(formatPath(tokens.slice(from))) : humanizeFieldKey(root);
    const step = root === 'steps' ? stepLabelById?.get?.(String(tokens[1]?.key ?? '')) : null;
    return step ? `${step} ▸ ${tail}` : tail;
}

function fieldStart(root, tokens) {
    if (root === 'steps') return tokens[2]?.key === 'output' ? 3 : 2;
    if (root === 'trigger') return tokens[1]?.key === 'output' ? 2 : 1;
    return ROOT_SKIP.get(root) ?? 0;
}

/** One entry of the list a quantified row checks, in words: "attachment". */
function entryName(list) {
    const tokens = parsePath(list);
    const key = tokens?.length ? tokens[tokens.length - 1].key : null;
    return humanizeFieldKey(singularKey(typeof key === 'string' ? key : 'items')).toLowerCase();
}

/** `{ name, list, file }` for a row's left side, or null when it is no field (a formula). */
function ruleField(path, stepLabelById, t) {
    const shape = path ? fieldShape(path) : null;
    // A path the shapes do not cover (a whole list, `results[*]`) still has a name.
    if (!shape) return path && parsePath(path) ? { name: fieldName(path, stepLabelById), list: null, file: false } : null;
    if (shape.kind === 'fileRecord' || shape.kind === 'fileList') {
        return { name: say(t, 'condition_node.file_type.label', 'File type'), list: shape.list || null, file: true };
    }
    if (shape.kind === 'column') return { name: humanizeFieldTail(shape.column), list: shape.list, file: false };
    return { name: fieldName(shape.path, stepLabelById), list: null, file: false };
}

/** The value of a row: a file type's name, “quoted” text, a number bare, a field by its name. */
function ruleValue(row, field, stepLabelById, t) {
    const v = row.value;
    if (v?.kind === 'ref' && v.path) return fieldName(v.path, stepLabelById);
    const raw = v?.kind === 'literal' ? v.value : v?.value;
    if (raw === '' || raw == null) return '';
    if (field.file && FILE_TYPE_EN.has(raw)) return say(t, `condition_node.file_type.${raw}`, FILE_TYPE_EN.get(raw));
    return typeof raw === 'string' ? `“${raw}”` : String(raw);
}

// An emptiness test on a plural field (`attachments`) reads like the editor's list of
// records ("has at least one"); a card has no sample, so the name is the evidence.
function readsAsRecords(row, path) {
    if (row.op !== 'isEmpty' && row.op !== 'isNotEmpty') return false;
    const tokens = fieldShape(path)?.kind === 'plain' ? parsePath(path) : null;
    const key = tokens?.length > 1 ? tokens[tokens.length - 1].key : null;
    return typeof key === 'string' && singularKey(key) !== key;
}

/** The type that picks the operator's words (dates read "is after"); the value is a sentence's only evidence of it. */
function sentenceType(row, field, path) {
    if (field.file) return 'fileType';
    if (readsAsRecords(row, path)) return 'records';
    return row.value?.kind === 'literal' ? inferType(row.value.value) : 'unknown';
}

function rowSentence(row, stepLabelById, t) {
    const path = row?.field?.kind === 'ref' ? row.field.path : '';
    const field = ruleField(path, stepLabelById, t);
    if (!field) return null;
    const type = sentenceType(row, field, path);
    const value = isUnaryOp(row.op) ? '' : ruleValue(row, field, stepLabelById, t);
    const body = [field.name, labelFor(row.op, type, t), value].filter(Boolean).join(' ');
    if (!row.quantifier || !field.list || !QUANTIFIER_EN.has(row.quantifier)) return body;
    const which = say(t, `condition_node.quantifier.${row.quantifier}`, QUANTIFIER_EN.get(row.quantifier), { name: entryName(field.list) });
    return `${which} · ${body}`;
}

/**
 * A rule as the sentence its clickable rows read, or null when the rows
 * cannot show it (a formula):
 *
 *   contains(item.subject, "isv")                         → Subject contains “isv”
 *   anyOf(fileType(item.attachments[*]), "equals", "pdf") → any attachment · File type is PDF
 *   item.amount > 1000 && item.paid == false              → Amount greater than 1000 and Paid is false
 *
 * A rule that is not there yet (empty, `true`, `false`) is ''. Never a path,
 * a function name or a step id.
 *
 * @param {string|null|undefined} expr
 * @param {Pick<Map<string, string>, 'get'>|null} [stepLabelById]
 * @param {((key: string, en: string, vars?: Record<string, unknown>) => string)|null} [t]
 * @returns {string|null}
 */
export function ruleSentence(expr, stepLabelById = null, t = null) {
    const src = String(expr ?? '').trim();
    if (TRIVIAL_RULES.has(src)) return '';
    const parsed = parseExprToRows(src);
    if (!parsed?.rows?.length) return null;
    const parts = parsed.rows.map((row) => rowSentence(row, stepLabelById, t));
    if (parts.some((p) => p == null)) return null;
    const sep = parsed.join === '||' ? say(t, 'condition_node.join.or', 'or') : say(t, 'condition_node.join.and', 'and');
    return parts.join(` ${sep} `);
}

/**
 * The rule for a card or a preview line: its sentence, and "Custom rule" for
 * a formula the rows cannot show (the formula itself lives in Advanced).
 * @param {string|null|undefined} expr
 * @param {Pick<Map<string, string>, 'get'>|null} [stepLabelById]
 * @param {((key: string, en: string, vars?: Record<string, unknown>) => string)|null} [t]
 * @returns {string}
 */
export function describeRuleExpr(expr, stepLabelById = null, t = null) {
    return ruleSentence(expr, stepLabelById, t) ?? say(t, 'condition_node.custom.title', 'Custom rule');
}

/**
 * Which known step a validation record is about. Records carry an id-based
 * `path` like `steps[<id>].expr` (server/automation/validate.js) — same
 * substring-match technique as matchValidationToStep.js/sectionForIssue.js.
 * Prefers the LONGEST matching id so a short id can't shadow a longer one
 * that happens to contain it as a substring.
 */
export function resolveOwningStepId(record, def) {
    const path = record?.path;
    if (typeof path !== 'string' || !def) return null;
    const allIds = [def.trigger?.id, ...(def.steps || []).map(s => s.id)].filter(Boolean);
    let best = null;
    for (const id of allIds) {
        if (path.includes(id) && (!best || id.length > best.length)) best = id;
    }
    return best;
}

/**
 * Replace any KNOWN step id appearing literally in a validation message
 * (e.g. `Step cond_7f748746: unknown type...`, `runPartial: step
 * cond_7f748746 not found`) with its human label, quoted for readability.
 * Ids with no entry in `labelById` (e.g. a stale reference to an already-
 * deleted step) are left as-is — there's no real name to substitute, and
 * that's itself part of what the message is reporting.
 */
export function humanizeIssueText(text, labelById) {
    if (!text || typeof text !== 'string' || !labelById?.size) return text;
    const ids = [...labelById.keys()].filter(Boolean).sort((a, b) => b.length - a.length);
    if (!ids.length) return text;
    const pattern = new RegExp(`\\b(${ids.map(id => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'g');
    return text.replace(pattern, (id) => `"${labelById.get(id) || id}"`);
}
