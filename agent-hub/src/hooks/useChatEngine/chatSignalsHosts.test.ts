// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guard: every caller of the counted chat endpoints, listed (legal verdict,
 * amendment 16: "add a test that lists every caller of /ai/chat/direct/stream").
 *
 * The server counts a turn only when it carries the chat-signals marker, and
 * the marker may only travel from a screen that shows the notice. On the web
 * the marker is added by the chat engine, and only for a host that passes
 * `getChatSignalsPayload`. So the reviewed facts are:
 *
 *   1. the direct stream's path is written down in exactly one module
 *      (turnEndpoint.ts), so no screen posts to it around the engine;
 *   2. the screens that run the chat engine are exactly the list below;
 *   3. only the Agent Hub chat (which renders the notice in both composers)
 *      hands the engine the marker getter. The meeting-notes sidebar, the
 *      templates page, the webpage editor and the notebook post through the
 *      same engine without a notice, so they send no marker and are not
 *      counted.
 *
 * A new host is a red test: add it only after deciding that it shows the
 * notice before it passes the getter.
 *
 * Same method as server/layering.test.js: walk the tree, derive the lists,
 * assert on the derived lists.
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP = new Set(['node_modules', 'i18n', 'demo', 'assets']);

function walk(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (!SKIP.has(e.name)) walk(full, out);
        } else if (/\.(js|jsx|ts|tsx)$/.test(e.name) && !/\.test\.(js|jsx|ts|tsx)$/.test(e.name)) {
            out.push(full);
        }
    }
    return out;
}

const rel = (file: string) => path.relative(SRC, file).split(path.sep).join('/');
/** Source without comments, so a doc example is not a call. */
const code = (file: string) => fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

const FILES = walk(SRC).map((file) => ({ file: rel(file), code: code(file) }));
const where = (re: RegExp) => FILES.filter((f) => re.test(f.code)).map((f) => f.file).sort();

const DIRECT_STREAM_WRITERS = where(/\/ai\/chat\/direct\/stream/);
const ENGINE_HOSTS = where(/\buseChatEngine\s*\(/).filter((f) => f !== 'hooks/useChatEngine.ts');
const MARKER_HOSTS = where(/\bgetChatSignalsPayload\b/).filter((f) => !f.startsWith('hooks/useChatEngine'));

describe('chat signals: who can send the marker', () => {
    it('the direct stream path is written down only in turnEndpoint.ts', () => {
        expect(DIRECT_STREAM_WRITERS).toEqual(['hooks/useChatEngine/turnEndpoint.ts']);
    });

    it('the screens that run the chat engine are the reviewed list', () => {
        expect(ENGINE_HOSTS).toEqual([
            'AgentHub/useAgentHubData.js',
            'pages/TemplatesPage.jsx',
            'pages/meeting-notes/detail/AssistantSidebar.jsx',
            'pages/notebooks/detail/useNotebookChat.ts',
            'pages/webpages/WebpageEditorPage.jsx',
        ]);
    });

    it('only the Agent Hub chat, which shows the notice, hands the engine the marker getter', () => {
        expect(MARKER_HOSTS).toEqual(['AgentHub/useAgentHubData.js']);
    });

    it('the walk sees the tree (the guard is not vacuous)', () => {
        expect(FILES.length).toBeGreaterThan(200);
    });
});
