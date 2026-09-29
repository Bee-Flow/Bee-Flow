/**
 * A scheduled run must actually send the email it was asked to send.
 *
 * gmail_compose returns an `email_draft` "waiting for user approval" object
 * unless the caller passes autoSend. That approval lives in the chat UI — a
 * background run has no such surface, so the draft was parked forever while
 * the run reported success and told the user it had drafted something. A
 * cowork whose entire brief is "email me every morning" therefore did nothing,
 * every morning, and said it had worked.
 *
 * The second half matters as much: `unattended` is derived from autoSend and
 * the custom-integration runner refuses unattended calls outright, so turning
 * autoSend on naively would convert working routines into hard failures. The
 * task runner pins unattended:false to keep that path exactly as it was.
 *
 * Run: node --test core/aiTaskRunner.autoSend.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const RUNNER = fs.readFileSync(path.join(__dirname, 'aiTaskRunner.js'), 'utf8');
const DISPATCHER = fs.readFileSync(path.join(__dirname, 'tools', 'toolDispatcher.js'), 'utf8');
// The agent runtime's tool dispatch moved with the tool round into
// agentRuntime/toolRoundExecutor.js — scan the spine and the round together.
// The spine is a FOLDER (agentRuntime/chatStream/), so every module in it is
// read: a scan that stopped at the entry point would cover almost none of it.
const CHAT_STREAM_DIR = path.join(__dirname, 'agentRuntime', 'chatStream');
const CHAT_STREAM = [
    ...fs.readdirSync(CHAT_STREAM_DIR).filter(f => f.endsWith('.js')).sort()
        .map(f => path.join('chatStream', f)),
    'toolRoundExecutor.js',
].map(f => fs.readFileSync(path.join(__dirname, 'agentRuntime', f), 'utf8'))
    .join('\n');

/** The object literal passed to the runner's executeTool call. */
function runnerDispatchContext() {
    const at = RUNNER.indexOf('result = await executeTool(');
    assert.notStrictEqual(at, -1, 'the runner no longer dispatches tools this way');
    const open = RUNNER.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < RUNNER.length; i += 1) {
        if (RUNNER[i] === '{') depth += 1;
        else if (RUNNER[i] === '}') {
            depth -= 1;
            if (depth === 0) return RUNNER.slice(open, i + 1);
        }
    }
    throw new Error('could not delimit the dispatch context');
}

test('the plain task path dispatches with autoSend', () => {
    assert.match(runnerDispatchContext(), /autoSend:\s*true/);
});

test('the plain task path pins unattended to false', () => {
    // Not merely absent — explicit, so the dispatcher's autoSend fallback
    // cannot promote custom integrations to a refused unattended dispatch.
    assert.match(runnerDispatchContext(), /unattended:\s*false/);
});

test('the dispatcher lets unattended be set independently of autoSend', () => {
    assert.match(
        DISPATCHER,
        /unattended:\s*context\.unattended\s*!==\s*undefined\s*\?\s*!!context\.unattended\s*:\s*!!context\.autoSend/,
        'unattended must prefer an explicit value and only fall back to autoSend',
    );
});

test('the agent-routine path passes autoSend through its metadata', () => {
    // The metadata literal, delimited by braces — `chatWithAgentStream` is
    // required further up the function, so it is not a usable end marker.
    const at = RUNNER.indexOf('const messageMetadata');
    assert.notStrictEqual(at, -1, 'executeAgentRoutine no longer builds messageMetadata');
    const open = RUNNER.indexOf('{', at);
    let depth = 0;
    let meta = '';
    for (let i = open; i < RUNNER.length; i += 1) {
        if (RUNNER[i] === '{') depth += 1;
        else if (RUNNER[i] === '}') {
            depth -= 1;
            if (depth === 0) { meta = RUNNER.slice(open, i + 1); break; }
        }
    }
    assert.match(meta, /autoSend:\s*true/, 'executeAgentRoutine must mark the run unattended-sending');
});

test('the agent runtime forwards autoSend to the dispatcher', () => {
    assert.match(CHAT_STREAM, /autoSend:\s*!!messageMetadata\.autoSend/);
});

test('the agent runtime also pins unattended, so chat is unchanged', () => {
    const at = CHAT_STREAM.indexOf('autoSend: !!messageMetadata.autoSend');
    const window = CHAT_STREAM.slice(at, at + 400);
    assert.match(window, /unattended:\s*false/);
});

test('normal chat still gets a draft to approve', () => {
    // messageMetadata.autoSend is absent outside routine runs, so the
    // expression above evaluates false and the preview flow is untouched.
    assert.doesNotMatch(
        CHAT_STREAM,
        /autoSend:\s*true/,
        'the streaming chat path must never hard-code autoSend',
    );
});
