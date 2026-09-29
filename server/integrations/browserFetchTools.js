/**
 * Browse Web Tool — an interactive headless browser the model can drive to
 * read/interact with live web pages (JS-rendered SPAs, dashboards, multi-page
 * research, cookie walls) and answer the user's task.
 *
 * Backed by services/browserAgentDriver.js (an inner pw_* tool-use loop over
 * the shared, network-isolated bf-browser container). While it runs, it streams
 * browser_session_start/queued/frame/action/end events over the chat SSE `send`
 * so the UI shows a live preview.
 *
 * Concurrency: the shared browser container has finite capacity, so calls are
 * capped at MAX_CONCURRENT in-flight sessions per server process; additional
 * calls queue (FIFO) instead of being rejected, up to MAX_QUEUE_WAIT_MS.
 */

const crypto = require('crypto');
const log = require('../telemetry/log');

const MAX_CONCURRENT = parseInt(process.env.BROWSER_FETCH_MAX_CONCURRENT || '4', 10);
const MAX_QUEUE_WAIT_MS = parseInt(process.env.BROWSER_FETCH_MAX_QUEUE_WAIT_MS || '45000', 10);

let _active = 0;
const _queue = [];

function queuePosition() {
    return _queue.length;
}

function acquireBrowserSlot() {
    return new Promise((resolve, reject) => {
        if (_active < MAX_CONCURRENT) {
            _active++;
            resolve();
            return;
        }
        const entry = {};
        entry.settle = () => {
            clearTimeout(entry.timer);
            _active++;
            resolve();
        };
        entry.timer = setTimeout(() => {
            const idx = _queue.indexOf(entry);
            if (idx !== -1) _queue.splice(idx, 1);
            reject(new Error('queue_timeout'));
        }, MAX_QUEUE_WAIT_MS);
        _queue.push(entry);
    });
}

function releaseBrowserSlot() {
    _active--;
    const next = _queue.shift();
    if (next) next.settle();
}

/**
 * Tool definitions in OpenAI function-calling format.
 */
const BROWSE_WEB_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'browse_web',
            description: `Open and read (or interact with) live web pages in a real headless browser that runs JavaScript, then answer the user's task from what you actually see.

Use browse_web whenever:
• The user gives you a specific URL — open it directly. Do NOT use agent_search for a URL you already have.
• A task needs live/current page content, a JS-rendered page (SPA/dashboard), clicking through a cookie wall, expanding sections, following links, or reading across several pages.
• The URL is a PDF document — browse_web reads its text securely.

Use agent_search (not this) only to DISCOVER pages when you have no URL. Once agent_search gives you a promising URL, you may open it with browse_web.

This drives a shared, capacity-limited browser and takes several seconds (it navigates and reads step by step) — call it once with a clear task, not repeatedly.`,
            parameters: {
                type: 'object',
                properties: {
                    task: {
                        type: 'string',
                        description: 'What to read, find, or do on the page(s) — e.g. "read this article and summarize what it says about X", "find the pricing on this site".',
                    },
                    url: {
                        type: 'string',
                        description: 'Optional absolute http(s) URL to open first. Provide it whenever you have a specific page in mind.',
                    },
                },
                required: ['task'],
            },
        },
    },
];

function isBrowseWebTool(toolName) {
    return toolName === 'browse_web';
}

/**
 * @param {string} toolName
 * @param {Object} args   { task, url }
 * @param {Object} [context]
 * @param {(type: string, data: object) => void} [context.send]
 * @param {string} [context.userId]
 * @param {string} [context.orgId]
 * @param {string[]|null} [context.allowedHosts] — confine navigation (App
 *   Studio's per-app domain allowlist); chat passes nothing and stays open.
 * @param {()=>boolean} [context.isCancelled] — client-disconnect hook; ends
 *   the browse at the next step boundary and frees the slot.
 * @param {number|null} [context.maxSteps] — per-call step cap.
 */
async function executeBrowseWebTool(toolName, args, context = {}) {
    if (!isBrowseWebTool(toolName)) {
        return { error: `Unknown tool: ${toolName}` };
    }
    const { send, userId = null, orgId = null, allowedHosts = null, isCancelled = null, maxSteps = null } = context;
    const task = (args?.task || '').trim();
    const url = (args?.url || '').trim() || null;
    if (!task && !url) return { error: 'task is required' };

    const sessionId = crypto.randomUUID();
    const waitedInQueue = _active >= MAX_CONCURRENT;
    if (waitedInQueue && send) {
        send('browser_session_queued', { sessionId, url, task, queuePosition: queuePosition() + 1 });
    }

    try {
        await acquireBrowserSlot();
    } catch (err) {
        return `The browser is at capacity and the wait exceeded ${Math.round(MAX_QUEUE_WAIT_MS / 1000)}s — try again shortly, or use agent_search if the content doesn't require a live browser.`;
    }

    try {
        if (send) send('browser_session_start', { sessionId, url, task });

        const { runBrowseTask } = require('../services/browserAgentDriver');
        const result = await runBrowseTask({
            task,
            startUrl: url,
            userId,
            orgId,
            onFrame: send ? (b64) => send('browser_frame', { sessionId, b64 }) : null,
            onAction: send ? (a) => send('browser_action', { sessionId, ...a }) : null,
            isCancelled,
            allowedHosts,
            maxSteps,
        });

        if (result.status === 'error') {
            return `Could not complete the browse task: ${result.error || 'unknown error'}.`;
        }
        if (result.status === 'empty' || !result.answer || result.answer.trim().length < 20) {
            return `The page(s) loaded but produced almost no readable content for this task (they may need a login, show a CAPTCHA, or block automated browsers). Do not fabricate an answer.`;
        }

        const sources = (result.visitedUrls || []).length
            ? `\n\n---\n**Pages read:**\n${result.visitedUrls.map(u => `- ${u}`).join('\n')}`
            : '';
        const trailer = result.status === 'timeout'
            ? `\n\n> Note: the browser stopped at its time limit after ${result.steps} steps — this may be partial.`
            : '';
        return `${result.answer}${sources}${trailer}\n\n> Read live via a headless browser. Only the content above was actually on the page(s).`;
    } catch (err) {
        log.error(`[BrowseWeb] Failed task (${url || 'no url'}): ${err.message}`);
        return `Could not complete the browse task: ${err.message}.`;
    } finally {
        if (send) send('browser_session_end', { sessionId });
        releaseBrowserSlot();
    }
}

module.exports = {
    BROWSE_WEB_TOOLS,
    isBrowseWebTool,
    executeBrowseWebTool,
};
