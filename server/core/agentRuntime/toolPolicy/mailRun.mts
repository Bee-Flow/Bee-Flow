/**
 * A run started by a received e-mail (core/cowork/mailTriggerRun.mts): which tools it may use, and when its reply
 * goes out as a draft instead.
 *
 * Nobody is present in such a run, and the text it reads was written by someone outside the workspace. So the stack
 * is an ALLOW-LIST, never "everything except":
 *
 *   - the Gmail / Outlook tools, as the app's `mailAccess` says (./mailAccess.js);
 *   - tools that only read inside Bee Flow or the owner's own connected apps (`reads` in the side-effect map), except
 *     the ones that fetch an address or a query on the open web, or mint a link that opens without signing in;
 *   - `kb_fetch` (it serves the run's own `kb_search` results) and `activate_skill` (text only in such a run, see
 *     core/tools/skillInjection.js);
 *   - every other tool only for an app whose owner switched it on for these runs (`mailRuns: true` on the app entry
 *     in `config.tools`), and then never one that would ask for a confirmation: there is nobody to ask.
 *
 * The run also remembers whether it used a tool outside the thread it was started for (`readOutside` on the
 * mail-trigger context). A reply in the thread then goes to the owner's drafts instead of being sent
 * (../../../integrations/mailReplyGuard.js).
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Effect = 'reads' | 'writes' | 'sends';
const { effectOf } = nodeRequire('../../automationModel/sideEffectMap.js') as { effectOf: (name: string) => Effect };
const { MAIL_APPS, mailAccessOf } = nodeRequire('./mailAccess.js') as {
    MAIL_APPS: Record<'gmail' | 'outlook', { draft: string; reply: string }>;
    mailAccessOf: (appId: string, entry: unknown) => 'read' | 'draft' | 'send_reply' | null;
};

type ToolsConfig = Record<string, unknown> | null | undefined;

/** Reads that go to the open web with an address or a query the caller picks, or that mint a link anyone can open. */
export const OUTSIDE_READS: ReadonlySet<string> = new Set([
    'read_url', 'agent_search', 'web_search', 'browse_web', 'http_request',
    'maps_search_places', 'maps_geocode', 'maps_directions',
    'nextcloud_direct_link', 'slides_export_pdf',
]);

/** Tools that are not in the side-effect map but only work on what the run itself has: kept. */
export const RUN_LOCAL_TOOLS: ReadonlySet<string> = new Set(['kb_fetch', 'activate_skill']);

/** Tools whose use does not take the run outside the triggering thread. */
const THREAD_TOOLS: ReadonlySet<string> = new Set([
    'activate_skill',
    ...Object.values(MAIL_APPS).flatMap((a) => [a.draft, a.reply]),
]);
/** Mail reads that stay in the thread when what they read belongs to it. */
const THREAD_READS: ReadonlySet<string> = new Set(['gmail_read', 'outlook_read', 'gmail_read_attachment']);

function plainObject(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Did the owner switch this app on for runs started by an e-mail? Only a stored `true` counts. */
export function appOptedInForMailRuns(toolsConfig: ToolsConfig, appId: string | null | undefined): boolean {
    if (!appId || !plainObject(toolsConfig)) return false;
    const entry = toolsConfig[appId];
    return plainObject(entry) && entry.mailRuns === true;
}

/** Did the owner allow replies to everyone on the mail (`replyAll: true` on the Gmail or Outlook entry)? */
export function replyAllAllowed(toolsConfig: ToolsConfig, appId: string | null | undefined): boolean {
    if (!appId || !plainObject(toolsConfig) || !Object.prototype.hasOwnProperty.call(MAIL_APPS, appId)) return false;
    const entry = toolsConfig[appId];
    return plainObject(entry) && entry.replyAll === true;
}

/** A Gmail or Outlook tool in a mail-started run: reads always, the draft / reply tool per `mailAccess`. */
function keepMailAppTool(name: string, appId: 'gmail' | 'outlook', toolsConfig: ToolsConfig): boolean {
    if (name.endsWith('_compose') || name.includes('forward')) return false;
    if (effectOf(name) === 'reads') return true;
    const level = mailAccessOf(appId, plainObject(toolsConfig) ? toolsConfig[appId] : null);
    const apps = MAIL_APPS[appId];
    if (name === apps.draft) return level === 'draft' || level === 'send_reply';
    if (name === apps.reply) return level === 'send_reply';
    return false;
}

export interface MailRunToolQuestion {
    /** The tool name. */
    name: string;
    /** The app that supplies it (`mcp:<id>` / `custom:<id>` for those), or null. */
    appId: string | null | undefined;
    /** The agent's stored `config.tools`. */
    toolsConfig: ToolsConfig;
    /** Would this call ask a person first (confirmForTool / a granted automation's own confirm)? */
    asks: boolean;
    /** True for a granted automation offered as a tool. */
    isAutomation?: boolean;
}

/** May a run started by an e-mail use this tool? */
export function keepInMailRun({ name, appId, toolsConfig, asks, isAutomation = false }: MailRunToolQuestion): boolean {
    if (typeof name !== 'string' || !name) return false;
    if (appId === 'gmail' || appId === 'outlook') return keepMailAppTool(name, appId, toolsConfig);
    // A mail tool whose app could not be told (degraded index) is not a mail tool the owner set up: not offered.
    if (Object.values(MAIL_APPS).some((a) => a.draft === name || a.reply === name)) return false;
    if (isAutomation) return false;
    if (!OUTSIDE_READS.has(name) && (RUN_LOCAL_TOOLS.has(name) || effectOf(name) === 'reads')) return true;
    return appOptedInForMailRuns(toolsConfig, appId) && !asks;
}

export interface MailTriggerTaint {
    messageId?: string | null;
    threadId?: string | null;
    readOutside?: boolean;
}

function resultObject(value: unknown): Record<string, unknown> | null {
    if (plainObject(value)) return value;
    if (typeof value !== 'string' || !value.startsWith('{')) return null;
    try {
        const parsed: unknown = JSON.parse(value);
        return plainObject(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

/** Did this call stay inside the triggering thread? */
function staysInThread(mailTrigger: MailTriggerTaint, name: string, args: unknown, value: unknown): boolean {
    if (THREAD_TOOLS.has(name)) return true;
    if (!THREAD_READS.has(name)) return false;
    const a = plainObject(args) ? args : {};
    if (name === 'gmail_read_attachment') return !!mailTrigger.messageId && a.messageId === mailTrigger.messageId;
    const read = resultObject(value);
    const thread = read ? (read.threadId ?? read.conversationId) : null;
    return !!mailTrigger.threadId && typeof thread === 'string' && thread === mailTrigger.threadId;
}

/**
 * Record one tool call of a mail-started run on its mail-trigger context: anything that is not the triggering
 * thread itself marks the run as having read outside it. Never throws.
 */
export function noteMailRunToolUse(mailTrigger: MailTriggerTaint | null | undefined, name: string, args: unknown, value: unknown): void {
    if (!mailTrigger || typeof mailTrigger !== 'object' || mailTrigger.readOutside === true) return;
    try {
        if (!staysInThread(mailTrigger, String(name || ''), args, value)) mailTrigger.readOutside = true;
    } catch {
        mailTrigger.readOutside = true;
    }
}
