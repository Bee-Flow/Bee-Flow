/**
 * The agent_call declaration contract: the tool name, the schema the builder
 * writes and the canvas editor reads, and the rules the validator applies.
 *
 * Run: node --test automation/agentCallContract.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const {
    sanitizeToolName, normalizeParameters, agentCallFieldsFrom, validateAgentCallTrigger, agentCallParams, MAX_TOOL_DESCRIPTION_LEN,
} = require('./agentCallContract');
const { automationToTool } = require('./agentCallableTools');

const codes = (t) => validateAgentCallTrigger(t).map(i => i.code);
const valid = { kind: 'agent_call', toolName: 'lookup', description: 'Looks a thing up.' };

test('sanitizeToolName is the one rule for the builder and the runtime', () => {
    assert.strictEqual(sanitizeToolName('Lookup Warranty!'), 'lookup_warranty');
    assert.strictEqual(sanitizeToolName('  __x__ '), 'x');
    assert.strictEqual(sanitizeToolName('!!!'), 'automation_unnamed');
    assert.strictEqual(sanitizeToolName('a'.repeat(100)).length, 64);
});

test('a params list becomes exactly the schema the canvas editor writes (agent-hub paramsToSchema)', () => {
    // The same input and expected value as flow/triggerSchemaUtils.test.js.
    const { schema, notes } = normalizeParameters({
        params: [
            { name: 'limit', type: 'number', required: true, description: 'how many' },
            { name: 'verbose', type: 'boolean', required: false },
        ],
    });
    assert.deepStrictEqual(schema, {
        type: 'object',
        properties: { limit: { type: 'number', description: 'how many' }, verbose: { type: 'boolean' } },
        required: ['limit'],
        additionalProperties: false,
    });
    assert.deepStrictEqual(notes, []);
});

test('a JSON Schema is read into the same shape; integer folds into number, enum and items ride along', () => {
    const { schema } = normalizeParameters({
        parametersSchema: {
            type: 'object',
            properties: {
                count: { type: 'integer', description: 'n' },
                kind: { type: 'string', enum: ['a', 'b'] },
                tags: { type: 'array', items: { type: 'string' } },
            },
            required: ['count'],
        },
    });
    assert.deepStrictEqual(schema.properties.count, { type: 'number', description: 'n' });
    assert.deepStrictEqual(schema.properties.kind, { type: 'string', enum: ['a', 'b'] });
    assert.deepStrictEqual(schema.properties.tags, { type: 'array', items: { type: 'string' } });
    assert.deepStrictEqual(schema.required, ['count']);
    assert.strictEqual(schema.additionalProperties, false);
});

test('the {name: type} shorthand and a schema without type are read, and say so', () => {
    const short = normalizeParameters({ parametersSchema: { query: 'string', limit: { type: 'number' } } });
    assert.deepStrictEqual(Object.keys(short.schema.properties), ['query', 'limit']);
    assert.match(short.notes.join(' '), /\{name: type\} map/);

    const typeless = normalizeParameters({ parametersSchema: { properties: { q: { type: 'string' } } } });
    assert.ok(typeless.schema.properties.q);
});

test('required names that are not declared are dropped and named; a property-level required:true counts', () => {
    const { schema, notes } = normalizeParameters({
        parametersSchema: { type: 'object', properties: { a: { type: 'string', required: true }, b: { type: 'string' } }, required: ['ghost'] },
    });
    assert.deepStrictEqual(schema.required, ['a']);
    assert.match(notes.join(' '), /"ghost"/);
});

test('nothing declared stays undeclared; an empty object schema is a tool without arguments', () => {
    assert.strictEqual(normalizeParameters({}).schema, null);
    assert.strictEqual(normalizeParameters({ params: [] }).schema, null);
    assert.strictEqual(normalizeParameters({ parametersSchema: 'nope' }).schema, null);
    assert.deepStrictEqual(normalizeParameters({ parametersSchema: { type: 'object', properties: {} } }).schema,
        { type: 'object', properties: {}, additionalProperties: false });
});

test('names are kept as written (no silent rename), duplicates keep the first', () => {
    const { schema, notes } = normalizeParameters({ params: [{ name: 'a b', type: 'string' }, { name: 'x', type: 'string', description: 'one' }, { name: 'x', type: 'number' }] });
    assert.deepStrictEqual(Object.keys(schema.properties), ['a b', 'x']);
    assert.strictEqual(schema.properties.x.description, 'one');
    assert.match(notes.join(' '), /declared twice/);
});

test('agentCallFieldsFrom only returns what was given, and says what it rewrote', () => {
    assert.deepStrictEqual(agentCallFieldsFrom({ description: '  Does it.  ' }).fields, { description: 'Does it.' });
    const named = agentCallFieldsFrom({ toolName: 'Do It' });
    assert.strictEqual(named.fields.toolName, 'do_it');
    assert.match(named.notes[0], /"Do It" was written as "do_it"/);
    assert.strictEqual(agentCallFieldsFrom({ toolName: '' }).fields.toolName, null, 'an empty name clears it');
    assert.strictEqual(agentCallFieldsFrom({ params: [] }).fields.parametersSchema, null, 'an explicit empty list clears the declaration');
    const bad = agentCallFieldsFrom({ parametersSchema: 'junk' });
    assert.ok(!('parametersSchema' in bad.fields));
    assert.match(bad.notes.join(' '), /could not be read/);
});

test('validate: a complete declaration is clean; an undeclared schema is legal', () => {
    assert.deepStrictEqual(codes(valid), []);
    assert.deepStrictEqual(codes({ ...valid, parametersSchema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } }), []);
});

test('validate: description, schema shape, names, types and required', () => {
    assert.deepStrictEqual(codes({ kind: 'agent_call' }), ['description_missing']);
    assert.ok(codes({ ...valid, toolName: '!!!' }).includes('tool_name'));
    assert.ok(codes({ ...valid, parametersSchema: { type: 'string' } }).includes('parameters_shape'));
    assert.ok(codes({ ...valid, parametersSchema: [] }).includes('parameters_shape'));
    assert.ok(codes({ ...valid, parametersSchema: { type: 'object', properties: [] } }).includes('properties_shape'));
    assert.ok(codes({ ...valid, parametersSchema: { type: 'object', properties: { 'bad name': { type: 'string' }, _hidden: { type: 'string' } } } }).filter(c => c === 'param_name').length === 2);
    assert.ok(codes({ ...valid, parametersSchema: { type: 'object', properties: { a: { type: 'date' } } } }).includes('param_type'));
    assert.ok(codes({ ...valid, parametersSchema: { type: 'object', properties: { a: { type: 'string' } }, required: ['b'] } }).includes('required_unknown'));
    assert.ok(codes({ ...valid, parametersSchema: { type: 'object', properties: { a: { type: 'string' } }, required: 'a' } }).includes('required_shape'));
});

test('agentCallParams lists the declared arguments with their binding-relevant type, skipping unaddressable names', () => {
    assert.deepStrictEqual(agentCallParams({ parametersSchema: { type: 'object', properties: { n: { type: 'integer', description: 'd' }, 'a b': { type: 'string' } }, required: ['n'] } }),
        [{ name: 'n', type: 'number', required: true, description: 'd' }]);
    assert.deepStrictEqual(agentCallParams({}), []);
});

test('what the normaliser writes is what the runtime exposes to the agent', () => {
    const { schema } = normalizeParameters({ params: [{ name: 'serial_number', type: 'string', required: true, description: 'sn' }] });
    const tool = automationToTool({ id: 'a1', userId: 'u1', title: 'T', definition: { trigger: { kind: 'agent_call', toolName: 'lookup_warranty', description: 'd', parametersSchema: schema } } });
    assert.strictEqual(tool.function.name, 'lookup_warranty');
    assert.deepStrictEqual(tool.function.parameters, schema);
    assert.deepStrictEqual(tool.function.parameters.required, ['serial_number']);
});

test('a tool without its own description falls back on the automation, and a long one is cut to the cap', () => {
    const tool = (automation, trigger) => automationToTool({ id: 'a1', userId: 'u1', title: 'Warranty check', ...automation, definition: { trigger: { kind: 'agent_call', ...trigger } } }).function.description;
    assert.strictEqual(tool({ description: 'From the automation.' }, { description: null }), 'From the automation.');
    assert.strictEqual(tool({}, { description: '' }), 'Run the "Warranty check" automation.');
    assert.strictEqual(tool({}, { description: 'y'.repeat(MAX_TOOL_DESCRIPTION_LEN + 200) }).length, MAX_TOOL_DESCRIPTION_LEN);
});
