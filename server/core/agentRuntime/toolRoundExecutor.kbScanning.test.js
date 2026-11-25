// @typecheck
/**
 * privacy_scan_knowledge_bases in the agent tool loop (toolRoundExecutor).
 *
 * The org setting governs query-time scanning of knowledge-base results too.
 * Default (true / absent): a kb_search result is pre-scanned for personal data
 * and tokenised. Off: it is neither scanned nor tokenised (unless the tool
 * class has a block list, which still strips), while any other tool's result
 * is scanned as before.
 *
 * Harness: agentTurn.testkit.js (shared with toolRoundExecutor.confirm.test.js).
 * Synthetic data.
 *
 * Run: node --test core/agentRuntime/toolRoundExecutor.kbScanning.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { installAgentTurnHarness, turnState, resetTurnState, fn } = require('./agentTurn.testkit');

const ARTICLE = 'https://help.openai.com/en/articles/20001519-custom-gpt-retirement-and-migration-faq';
const EMAIL = 'jan@example.test';
const S = { ...turnState(), toolMessages: [], scans: [] };
const TOOLS = [fn('kb_search'), fn('web_lookup')];

// Round 0 calls both tools, the next round collects what the model was shown.
const drive = (cb, options, round, messages) => {
    if (round === 0) {
        cb('tool_use', { id: 'call_kb', name: 'kb_search', input: { query: 'q' } });
        cb('tool_use', { id: 'call_web', name: 'web_lookup', input: { query: 'q' } });
    } else {
        S.toolMessages.push(...messages.filter(m => m.role === 'tool'));
        cb('text', { text: 'Done.' });
    }
    cb('done', {});
};

function reset(shieldExtra = {}) {
    resetTurnState(S, { drive, tools: TOOLS });
    S.toolMessages = [];
    S.scans = [];
    S.shield = {
        enabled: true, privacyAction: 'redact', piiDetectionConfidenceThreshold: 0.7,
        toolPiiPolicy: { external: { blockCategories: [] }, internal: { blockCategories: [] } },
        ...shieldExtra,
    };
}

const kit = installAgentTurnHarness(S, {
    stubs: {
        './contextBuilder': { buildSystemPrompt: async () => ({ stable: 'SYS', volatile: '', systemPrompt: 'SYS', volatileSystemPrompt: '' }) },
        '../tools/toolDispatcher': {
            executeTool: async (name) => {
                S.dispatched.push(name);
                if (name === 'kb_search') {
                    return {
                        _action: 'kb_sources',
                        _sources: [{ title: 'Notes', content: `contact ${EMAIL}` }],
                        results: [{ chunk_id: 'c1', title: 'Notes', content: `contact ${EMAIL}` }],
                    };
                }
                return { results: [`contact ${EMAIL} about ${ARTICLE}`] };
            },
        },
    },
});
test.after(() => kit.restore());

async function runTurn() {
    const { error } = await kit.runTurn();
    if (error) throw error;
}

// Every pre-scan goes through detectPii: record which tool result it was asked
// about, and report the planted address as an Email entity.
const piiDetection = require('../privacy/piiDetection');
const realDetect = piiDetection.detectPii;
piiDetection.detectPii = async (text, categories) => {
    if (!String(text).includes(EMAIL)) return { hasPii: false, entities: [] };
    S.scans.push(String(text));
    const entities = [[EMAIL, 'Email'], [ARTICLE, 'URL']]
        .filter(([value, category]) => text.includes(value) && (!categories || categories.includes(category)))
        .map(([value, category]) => ({ text: value, category, label: category, offset: text.indexOf(value), length: value.length }));
    return { hasPii: entities.length > 0, entities };
};
test.after(() => { piiDetection.detectPii = realDetect; });

const toolContent = (id) => S.toolMessages.find(m => m.tool_call_id === id)?.content || '';

test('default: the kb_search result and another tool result are scanned and tokenised', async () => {
    reset();
    await runTurn();
    assert.deepStrictEqual(S.dispatched.sort(), ['kb_search', 'web_lookup']);
    assert.strictEqual(S.scans.length, 2);
    assert.ok(!toolContent('call_kb').includes(EMAIL), 'kb result still tokenised');
    assert.ok(!toolContent('call_web').includes(EMAIL));
});

test('privacy_scan_knowledge_bases=true behaves as the default', async () => {
    reset({ privacy_scan_knowledge_bases: true });
    await runTurn();
    assert.strictEqual(S.scans.length, 2);
    assert.ok(!toolContent('call_kb').includes(EMAIL));
});

test('privacy_scan_knowledge_bases=false: kb_search result reaches the model untokenised, other tools still scanned', async () => {
    reset({ privacy_scan_knowledge_bases: false });
    await runTurn();
    assert.strictEqual(S.scans.length, 1, 'only the non-KB result is scanned');
    assert.ok(toolContent('call_kb').includes(EMAIL), 'kb passage is left as stored');
    assert.ok(!toolContent('call_web').includes(EMAIL), 'web/other results stay tokenised');
});

test('privacy_scan_knowledge_bases=false still strips a blocked category from a kb result', async () => {
    reset({
        privacy_scan_knowledge_bases: false,
        toolPiiPolicy: { external: { blockCategories: [] }, internal: { blockCategories: ['Email'] } },
    });
    await runTurn();
    assert.ok(!toolContent('call_kb').includes(EMAIL));
    assert.match(toolContent('call_kb'), /\[blocked:email\]/);
});

test('the URL in a tool result survives an email-only or empty selection', async () => {
    for (const categories of [['Email'], [], ['URL']]) {
        reset({ explicitPiiCategories: true, piiDetectionCategories: categories });
        await runTurn();
        const result = toolContent('call_web');
        assert.equal(result.includes(ARTICLE), !categories.includes('URL'));
        assert.equal(result.includes(EMAIL), !categories.includes('Email'));
        if (!categories.length) assert.equal(S.scans.length, 0);
    }
});

test('an empty AI selection still strips a category blocked for the tool', async () => {
    reset({
        explicitPiiCategories: true, piiDetectionCategories: [],
        toolPiiPolicy: { external: { blockCategories: [] }, internal: { blockCategories: ['Email'] } },
    });
    await runTurn();
    assert.match(toolContent('call_kb'), /\[blocked:email\]/);
    assert.ok(!toolContent('call_kb').includes(EMAIL));
});
