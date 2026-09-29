/**
 * Scheduled runs must not lecture the user about scheduling.
 *
 * A brief like "every morning, send me X" was producing the work followed by a
 * closing note: "I can't send this again automatically — this conversation is
 * one-off; set up a recurring automation in BeeFlow if you want this daily."
 * The user had already set exactly that up. The cause was the run's system
 * prompt: it said "you are executing a scheduled task" but never said WHAT the
 * schedule was, so the model filled the gap with a guess and an apology, on
 * every run.
 *
 * These tests pin both halves of the fix: the schedule is stated, and the
 * meta-commentary is forbidden.
 *
 * Run: node --test core/aiTaskRunner.schedulePrompt.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'aiTaskRunner.js'), 'utf8');

// buildTaskSystemPrompt/describeTaskSchedule are module-private (the module
// starts background timers on require, which a unit test should not do).
// Evaluate just the two pure functions in isolation.
function loadPromptBuilders() {
    const grab = (name) => {
        const start = SRC.indexOf(`function ${name}(`);
        assert.notStrictEqual(start, -1, `${name} not found — was it renamed?`);
        // Walk braces from the first '{' after the signature to its match.
        const open = SRC.indexOf('{', start);
        let depth = 0;
        for (let i = open; i < SRC.length; i += 1) {
            if (SRC[i] === '{') depth += 1;
            else if (SRC[i] === '}') {
                depth -= 1;
                if (depth === 0) return SRC.slice(start, i + 1);
            }
        }
        throw new Error(`could not delimit ${name}`);
    };

    const consts = SRC.slice(SRC.indexOf('const REPEAT_WORDS'), SRC.indexOf('/**\n * State this run'));
    return new Function(`
        ${consts}
        ${grab('describeTaskSchedule')}
        ${grab('buildTaskSystemPrompt')}
        return { describeTaskSchedule, buildTaskSystemPrompt };
    `)();
}

const { describeTaskSchedule, buildTaskSystemPrompt } = loadPromptBuilders();

const BASE = { title: 'Digest', prompt: 'Summarise', timezone: 'Europe/Amsterdam' };

// ── The schedule is stated ──────────────────────────────────────────

test('a daily repeat is spelled out, not left to the model to infer', () => {
    const text = describeTaskSchedule({ ...BASE, repeatInterval: 'daily' });
    assert.match(text, /every day/);
    assert.match(text, /already set up/);
});

test('a weekday repeat with a time names both', () => {
    const text = describeTaskSchedule({ ...BASE, repeatInterval: 'weekdays', timeOfDay: '09:00' });
    assert.match(text, /every weekday/);
    assert.match(text, /09:00/);
});

test('explicit weekdays are listed by name and beat the interval', () => {
    const text = describeTaskSchedule({ ...BASE, repeatInterval: 'daily', daysOfWeek: ['mon', 'wed'] });
    assert.match(text, /Monday, Wednesday/);
    assert.doesNotMatch(text, /every day/, 'the day list is more specific than the interval');
});

test('a one-off says so, and still frames it as the user\'s choice', () => {
    const text = describeTaskSchedule({ ...BASE });
    assert.match(text, /one-time run/);
    assert.match(text, /deliberately/);
});

test('an unrecognised interval degrades to the one-off wording, not a crash', () => {
    const text = describeTaskSchedule({ ...BASE, repeatInterval: 'fortnightly' });
    assert.match(text, /one-time run/);
});

// ── The meta-commentary is forbidden ────────────────────────────────

test('the system prompt carries the schedule', () => {
    const prompt = buildTaskSystemPrompt({ ...BASE, repeatInterval: 'daily' }, '');
    assert.match(prompt, /This run's schedule/);
    assert.match(prompt, /every day/);
});

test('the system prompt bans the exact advice the user was getting', () => {
    const prompt = buildTaskSystemPrompt({ ...BASE, repeatInterval: 'daily' }, '');
    assert.match(prompt, /never suggest creating a\s+recurring automation/i);
    assert.match(prompt, /never say\s+you cannot repeat or reschedule yourself/i);
    assert.match(prompt, /No meta-commentary/i);
});

test('a one-off run gets the same ban — it was the worse case', () => {
    // The one-off is exactly where the model used to volunteer the workaround.
    const prompt = buildTaskSystemPrompt(BASE, '');
    assert.match(prompt, /never suggest creating a\s+recurring automation/i);
});

test('the existing guidance survives the addition', () => {
    const prompt = buildTaskSystemPrompt({ ...BASE, repeatInterval: 'daily' }, 'TOOL HINT HERE');
    assert.match(prompt, /Do NOT ask follow-up questions/);
    assert.match(prompt, /USER'S local timezone/);
    assert.match(prompt, /TOOL HINT HERE/);
    assert.match(prompt, /^Now: /m);
});

// ── The agent-routine path gets the same treatment ──────────────────

test('agent routines pass the schedule through to the context builder', async () => {
    assert.match(SRC, /routineSchedule: describeTaskSchedule\(task\)/,
        'executeAgentRoutine must hand the schedule to agentRuntime');

    // The other half — that contextBuilder actually reads and honours a
    // routineSchedule — is called for real: buildSystemPrompt() is a pure
    // export with no boot-time side effect, so there is no reason to re-read
    // its source when calling it and inspecting the prompt it returns proves
    // the same property against the real, current implementation.
    const { buildSystemPrompt } = require('./agentRuntime/contextBuilder');
    const { stable } = await buildSystemPrompt({
        agent: { system_prompt: 'You help.' },
        tools: [],
        userId: 'u_schedule_test',
        messageMetadata: { routineSchedule: describeTaskSchedule({ ...BASE, repeatInterval: 'daily' }) },
        memoryContext: null,
        isStrictKnowledge: false,
    });
    assert.match(stable, /every day/, 'contextBuilder must read messageMetadata.routineSchedule');
    assert.match(stable, /never suggest creating a recurring automation/i,
        'and must carry the same ban as the non-agent path');
});
