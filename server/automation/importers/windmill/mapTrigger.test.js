/**
 * How a Windmill flow starts (mapTrigger.mts, eventClasses.mts): the
 * class-to-event table against the connector's own table, the cron
 * conversion, and the trigger each export shape yields.
 *
 * Run: cd server && node --test automation/importers/windmill/mapTrigger.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');

const { EXACT, eventForClass } = require('./eventClasses.mts');
const { toFiveFieldCron } = require('./mapTrigger.mts');
const { toIntermediate, toBeeFlow } = require('./index.mts');

const CONNECTOR = path.join(__dirname, '../../../../nextcloud-connector/src/webhookListeners.js');

/** The connector's EVENTS table, read from its syntax tree (class → event). */
function connectorEvents() {
    const ast = acorn.parse(fs.readFileSync(CONNECTOR, 'utf8'), { ecmaVersion: 'latest', sourceType: 'script' });
    for (const stmt of ast.body) {
        if (stmt.type !== 'VariableDeclaration') continue;
        for (const d of stmt.declarations) {
            if (d.id.name !== 'EVENTS' || d.init?.type !== 'ArrayExpression') continue;
            const out = {};
            for (const el of d.init.elements) {
                const prop = (k) => el.properties.find((p) => p.key.name === k)?.value.value;
                out[prop('class')] = prop('event');
            }
            return out;
        }
    }
    return null;
}

test('the event class table is the connector\'s, exactly', { skip: !fs.existsSync(CONNECTOR) && 'the connector is not in this checkout' }, () => {
    assert.deepStrictEqual({ ...EXACT }, connectorEvents());
});

test('approximate classes map with a note; unknown ones do not map', () => {
    assert.deepStrictEqual(eventForClass('\\OCP\\Files\\Events\\Node\\NodeCreatedEvent'), { event: 'file.new', exact: true });
    const touched = eventForClass('OCP\\Files\\Events\\Node\\NodeTouchedEvent');
    assert.strictEqual(touched.event, 'file.changed');
    assert.strictEqual(touched.exact, false);
    assert.strictEqual(eventForClass('OCP\\Share\\Events\\ShareCreatedEvent'), null);
});

test('a 6-field cron loses its seconds; macros are written out', () => {
    assert.deepStrictEqual(toFiveFieldCron('0 */5 * * * *'), { cron: '*/5 * * * *', secondsDropped: false });
    assert.deepStrictEqual(toFiveFieldCron('30 0 7 * * 1-5'), { cron: '0 7 * * 1-5', secondsDropped: true });
    assert.deepStrictEqual(toFiveFieldCron('0 0 9 ? * 1'), { cron: '0 9 * * 1', secondsDropped: false });
    assert.deepStrictEqual(toFiveFieldCron('@daily'), { cron: '0 0 * * *', secondsDropped: false });
    assert.deepStrictEqual(toFiveFieldCron('0 9 * * 1-5'), { cron: '0 9 * * 1-5', secondsDropped: false });
    assert.ok('problem' in toFiveFieldCron('0 0 12 L * *'));
    assert.ok('problem' in toFiveFieldCron('0 0 12 * * * 2027'));
    assert.ok('problem' in toFiveFieldCron('every day'));
});

const flow = (extra) => ({ summary: 'F', value: { modules: [{ id: 'a', value: { type: 'identity' } }] }, ...extra });

test('a flow with an input schema and no trigger becomes a form', async () => {
    const schema = { type: 'object', properties: { name: { type: 'string', description: 'Your name' }, kind: { type: 'string', enum: ['a', 'b'] }, ok: { type: 'boolean' }, db: { type: 'object', format: 'resource-postgresql' } }, required: ['name'] };
    const result = toBeeFlow(await toIntermediate({ kind: 'object', value: flow({ schema }) }));
    assert.deepStrictEqual(result.flows[0].trigger.form.fields, [
        { name: 'name', label: 'Your name', type: 'text', required: true },
        { name: 'kind', label: 'kind', type: 'select', options: ['a', 'b'] },
        { name: 'ok', label: 'ok', type: 'checkbox' },
    ]);
});

test('a flow without schema or trigger is manual', async () => {
    const result = toBeeFlow(await toIntermediate({ kind: 'object', value: flow({}) }));
    assert.strictEqual(result.flows[0].trigger.kind, 'manual');
});

test('Kafka and e-mail triggers are reported, never converted', async () => {
    const files = {
        'f/x/f__flow/flow.yaml': 'summary: F\nvalue:\n  modules: []\n',
        'f/x/k.kafka_trigger.yaml': 'script_path: f/x/f\nis_flow: true\n',
        'f/x/m.email_trigger.yaml': 'script_path: f/x/f\nis_flow: true\n',
    };
    const conv = toBeeFlow(await toIntermediate({ kind: 'files', files })).flows[0];
    assert.strictEqual(conv.trigger.kind, 'manual');
    const codes = conv.report.warnings.filter((w) => w.code === 'trigger_unsupported').map((w) => w.message);
    assert.strictEqual(codes.length, 2);
    assert.ok(codes.some((m) => m.includes('kafka')));
    assert.ok(codes.some((m) => m.includes('e-mail')));
});

test('a Mail event maps onto the Nextcloud Mail trigger', async () => {
    const files = {
        'f/x/f__flow/flow.yaml': 'summary: F\nvalue:\n  modules: []\n',
        'f/x/f.flow.1.nextcloud_native_trigger.json': JSON.stringify({ script_path: 'f/x/f', service_config: { event: 'OCA\\Mail\\Events\\NewMessageReceivedEvent' } }),
    };
    const conv = toBeeFlow(await toIntermediate({ kind: 'files', files })).flows[0];
    assert.strictEqual(conv.trigger.appEvent.event, 'mail.new');
});
