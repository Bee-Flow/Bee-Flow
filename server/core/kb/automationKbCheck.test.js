/**
 * The knowledge-base link check for automations.
 *
 * Two properties carry the design, and both are about WHEN it bites:
 *
 *   while building  → a warning, because the builder PUTs the whole definition
 *                     on every node edit and a blocked save loses work;
 *   on activation   → an error, because from there the automation runs unattended
 *                     and the runtime silently drops an id it cannot authorise
 *                     — going live with less knowledge than configured, with
 *                     nothing in the run to say so.
 *
 * Run: cd server && node --test --test-force-exit core/kb/automationKbCheck.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { kbStepFindings, collectKbSteps } = require('./automationKbCheck');

const KBS = {
    kb_ok: { id: 'kb_ok', name: 'Handbook', tenant_id: 'other', organization_id: 'org1', usage_contexts: ['agent', 'ai_step'] },
    kb_no_ctx: { id: 'kb_no_ctx', name: 'Interview notes', tenant_id: 'other', organization_id: 'org1', usage_contexts: ['direct_chat'] },
    kb_foreign: { id: 'kb_foreign', name: 'Theirs', tenant_id: 'someone', organization_id: 'org2', usage_contexts: ['ai_step'] },
    kb_mine: { id: 'kb_mine', name: 'My notes', tenant_id: 'u1', organization_id: null, usage_contexts: ['agent', 'ai_step'] },
    kb_legacy: { id: 'kb_legacy', name: 'Old', tenant_id: 'other', organization_id: 'org1', usage_contexts: null },
    kb_system: { id: 'kb_system', name: 'Bee Flow docs', tenant_id: 'sys', organization_id: null, usage_contexts: ['direct_chat'], source_kind: 'system_managed' },
};

const deps = {
    kbStore: {
        getKB: async (id) => KBS[id] || null,
        isSystemKB: (kb) => kb?.source_kind === 'system_managed',
    },
};

const WHO = { orgId: 'org1', userId: 'u1', deps };

function def(kbIds, over = {}) {
    return { steps: [{ id: 's1', type: 'ai_step', knowledgeBaseIds: kbIds, ...over }] };
}

test('a good link produces nothing', async () => {
    assert.deepStrictEqual(await kbStepFindings(def(['kb_ok']), { ...WHO, stage: 'activate' }), []);
});

test('a base its owner did not make available to automations is reported', async () => {
    const [f] = await kbStepFindings(def(['kb_no_ctx']), { ...WHO, stage: 'draft' });
    assert.strictEqual(f.code, 'kb.context_missing');
    assert.match(f.message, /Interview notes/);
    assert.strictEqual(f.path, 'steps.s1');
});

test('the same finding is a WARNING while building and an ERROR on activate', async () => {
    // The whole point: a half-built draft must stay saveable, and a live
    // automation must not run on knowledge it will silently be denied.
    const [draft] = await kbStepFindings(def(['kb_no_ctx']), { ...WHO, stage: 'draft' });
    const [live] = await kbStepFindings(def(['kb_no_ctx']), { ...WHO, stage: 'activate' });
    assert.strictEqual(draft.severity, 'warning');
    assert.strictEqual(live.severity, 'error');
    assert.strictEqual(draft.code, live.code);
});

test('a base in another organisation is refused, whatever its contexts say', async () => {
    const [f] = await kbStepFindings(def(['kb_foreign']), { ...WHO, stage: 'activate' });
    assert.strictEqual(f.code, 'kb.cross_org');
});

test('a base that no longer exists is named, not ignored', async () => {
    const [f] = await kbStepFindings(def(['kb_gone']), { ...WHO, stage: 'activate' });
    assert.strictEqual(f.code, 'kb.not_found');
    assert.match(f.message, /kb_gone/);
});

test("the owner's own personal base is fine on their own automation", async () => {
    // Legal today via the agent path, and the runtime allows it: the owner is
    // the tenant. Refusing it here would break automations that work.
    assert.deepStrictEqual(await kbStepFindings(def(['kb_mine']), { ...WHO, stage: 'activate' }), []);
});

test('a base that never expressed its contexts is usable, not refused', async () => {
    // NULL predates the column. A check that starts demanding a value would
    // fail every automation on an install that never set one.
    assert.deepStrictEqual(await kbStepFindings(def(['kb_legacy']), { ...WHO, stage: 'activate' }), []);
});

test('a system base is exempt — it has no owner to have expressed a preference', async () => {
    assert.deepStrictEqual(await kbStepFindings(def(['kb_system']), { ...WHO, stage: 'activate' }), []);
});

test('one bad id does not hide the others, and each is reported once', async () => {
    const out = await kbStepFindings(def(['kb_ok', 'kb_no_ctx', 'kb_gone']), { ...WHO, stage: 'activate' });
    assert.deepStrictEqual(out.map(f => f.code).sort(), ['kb.context_missing', 'kb.not_found']);
});

test('a definition with no ai_step asks the store nothing', async () => {
    let asked = 0;
    const counting = { kbStore: { getKB: async () => { asked += 1; return null; }, isSystemKB: () => false } };
    const out = await kbStepFindings({ steps: [{ id: 's1', type: 'http_request' }] }, { ...WHO, deps: counting, stage: 'activate' });
    assert.deepStrictEqual(out, []);
    assert.strictEqual(asked, 0);
});

describe_walker();
function describe_walker() {
    test('steps inside loops, parallel branches and layers are all found', async () => {
        const definition = {
            steps: [
                { id: 'a', type: 'ai_step', knowledgeBaseIds: ['kb_ok'] },
                { id: 'l', type: 'loop', body: [{ id: 'b', type: 'ai_step', knowledgeBaseIds: ['kb_ok'] }] },
                {
                    id: 'p', type: 'parallel',
                    branches: [[{ id: 'c', type: 'ai_step', knowledgeBaseIds: ['kb_ok'] }]],
                },
            ],
            layers: { onboarding: { steps: [{ id: 'd', type: 'ai_step', knowledgeBaseIds: ['kb_ok'] }] } },
        };
        const found = collectKbSteps(definition);
        assert.deepStrictEqual(found.map(f => f.id).sort(), ['a', 'b', 'c', 'd']);
    });

    test('a finding inside a layer says which layer', async () => {
        // The builder puts the marker on a node; a path that omits the layer
        // puts it on the wrong canvas.
        const definition = { layers: { onboarding: { steps: [{ id: 'd', type: 'ai_step', knowledgeBaseIds: ['kb_no_ctx'] }] } } };
        const [f] = await kbStepFindings(definition, { ...WHO, stage: 'draft' });
        assert.strictEqual(f.path, 'layers.onboarding.steps.d');
    });

    test('a step with an empty list is not a step with a problem', async () => {
        assert.deepStrictEqual(collectKbSteps({ steps: [{ id: 'a', type: 'ai_step', knowledgeBaseIds: [] }] }), []);
    });

    test('a malformed definition walks to nothing rather than throwing', async () => {
        for (const d of [null, undefined, {}, { steps: 'nope' }, { steps: [null, 5] }, { layers: 'nope' }]) {
            assert.deepStrictEqual(collectKbSteps(d), [], JSON.stringify(d));
        }
    });
}

// ── knowledge_write: the OTHER question ─────────────────────────────────
// Reading a base and adding to it are not the same permission, so a write
// link is checked against `canOwnerWriteToKb`, not against the read rules.

function wdef(kbId, over = {}) {
    return { steps: [{ id: 'w1', type: 'knowledge_write', knowledgeBaseId: kbId, content: '{{x}}', ...over }] };
}

/** A stand-in for kbWriteAccess: `ok` for the ids listed, refused otherwise. */
function writeAccess(okIds, reason = 'no_manage') {
    return {
        canOwnerWriteToKb: async (kbId) => (okIds.includes(kbId)
            ? { ok: true, kb: KBS[kbId] }
            : { ok: false, reason, kb: KBS[kbId] || undefined }),
        messageFor: (r, name) => `refused:${r}:${name || ''}`,
    };
}

test('a knowledge_write step is collected as a WRITE, an ai_step as a READ', () => {
    const found = collectKbSteps({
        steps: [
            { id: 'a', type: 'ai_step', knowledgeBaseIds: ['kb_ok'] },
            { id: 'w', type: 'knowledge_write', knowledgeBaseId: 'kb_ok' },
        ],
    });
    assert.deepStrictEqual(found.map(f => [f.id, f.access]), [['a', 'read'], ['w', 'write']]);
});

test('a write into a base the owner manages produces nothing', async () => {
    const out = await kbStepFindings(wdef('kb_mine'), {
        ...WHO, stage: 'activate', deps: { ...deps, writeAccess: writeAccess(['kb_mine']) },
    });
    assert.deepStrictEqual(out, []);
});

test('a write into a base the owner may READ but not manage is refused', async () => {
    // kb_ok passes every read rule: same org, available to automations. That is
    // exactly the case the read rules cannot catch.
    const [f] = await kbStepFindings(wdef('kb_ok'), {
        ...WHO, stage: 'activate', deps: { ...deps, writeAccess: writeAccess([]) },
    });
    assert.strictEqual(f.code, 'knowledge_write.kb_not_manageable');
    assert.strictEqual(f.severity, 'error');
    assert.strictEqual(f.path, 'steps.w1');
});

test('the write finding is a warning while building, an error on activate', async () => {
    const wa = { ...deps, writeAccess: writeAccess([]) };
    const [draft] = await kbStepFindings(wdef('kb_ok'), { ...WHO, stage: 'draft', deps: wa });
    const [live] = await kbStepFindings(wdef('kb_ok'), { ...WHO, stage: 'activate', deps: wa });
    assert.strictEqual(draft.severity, 'warning');
    assert.strictEqual(live.severity, 'error');
});

test('the wording comes from kbWriteAccess, so it does not name a base it should not', async () => {
    const [f] = await kbStepFindings(wdef('kb_foreign'), {
        ...WHO, stage: 'activate', deps: { ...deps, writeAccess: writeAccess([], 'other_org') },
    });
    assert.strictEqual(f.message, 'refused:other_org:Theirs');
});

test('a write step with no base set is left to the pure validator', async () => {
    // `knowledge_write.kb_required` already fires there on the same save; two
    // markers on one node saying the same thing is worse than one.
    let asked = 0;
    const wa = { ...deps, writeAccess: { canOwnerWriteToKb: async () => { asked += 1; return { ok: false }; }, messageFor: () => 'x' } };
    for (const bad of [undefined, '', null, 42]) {
        assert.deepStrictEqual(await kbStepFindings(wdef(bad), { ...WHO, stage: 'activate', deps: wa }), []);
    }
    assert.strictEqual(asked, 0);
});

test('the same base written by two steps is asked about once', async () => {
    let asked = 0;
    const wa = {
        ...deps,
        writeAccess: {
            canOwnerWriteToKb: async () => { asked += 1; return { ok: false, reason: 'no_manage' }; },
            messageFor: () => 'refused',
        },
    };
    const out = await kbStepFindings({
        steps: [
            { id: 'w1', type: 'knowledge_write', knowledgeBaseId: 'kb_ok' },
            { id: 'w2', type: 'knowledge_write', knowledgeBaseId: 'kb_ok' },
        ],
    }, { ...WHO, stage: 'activate', deps: wa });
    assert.strictEqual(asked, 1, 'one store round-trip, two markers');
    assert.deepStrictEqual(out.map(f => f.path), ['steps.w1', 'steps.w2']);
});

test('a write check that throws refuses rather than passing', async () => {
    const wa = {
        ...deps,
        writeAccess: {
            canOwnerWriteToKb: async () => { throw new Error('db down'); },
            messageFor: (r) => `refused:${r}`,
        },
    };
    const [f] = await kbStepFindings(wdef('kb_ok'), { ...WHO, stage: 'activate', deps: wa });
    assert.strictEqual(f.code, 'knowledge_write.kb_not_manageable');
});

test('a write step inside a loop body is found and pathed', async () => {
    const definition = {
        steps: [{ id: 'l', type: 'loop', body: [{ id: 'w', type: 'knowledge_write', knowledgeBaseId: 'kb_ok' }] }],
    };
    const [f] = await kbStepFindings(definition, {
        ...WHO, stage: 'activate', deps: { ...deps, writeAccess: writeAccess([]) },
    });
    assert.strictEqual(f.path, 'steps.w');
});
