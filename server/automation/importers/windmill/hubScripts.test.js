/**
 * The Hub table (hubScripts.mts): every one of the 24 Nextcloud Hub scripts
 * (appendix 7.2) lands on its Bee Flow target, matched on the slug and never
 * on the version number.
 *
 * Run: cd server && node --test automation/importers/windmill/hubScripts.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

const { hubEntryFor, planHub, parseHubPath } = require('./hubScripts.mts');
const { ALL_CAPABILITIES, capabilitiesFrom } = require('./capabilities.mts');

/** The 24 scripts by their Hub title, as a slug the way the Hub writes it. */
const slugOf = (title) => title.toLowerCase().split(' ').join('_');
const ALL = [
    ['Send a notification to a user', 'notification'],
    ['Nextcloud Talk: List all rooms', 'talkRooms'],
    ['Nextcloud Talk: Send a message', 'talkSend'],
    ['Nextcloud Tables: List all tables', 'tablesList'],
    ['Nextcloud Tables: Get all columns of a table', 'tablesColumns'],
    ['Nextcloud Tables: Create a row', 'special:createRow'],
    ['Edit a row in a table in Nextcloud Tables', 'special:editRow'],
    ['Nextcloud WebDAV: Get file content', 'readFile'],
    ['Nextcloud WebDAV: Upload or update a file', 'uploadFile'],
    ['List Files', 'listFiles'],
    ['Path from Fileid', 'special:pathFromFileid'],
    ['Create Share', 'special:createShare'],
    ['Create a group folder', 'special:groupFolder'],
    ['Nextcloud Calendar: Create event', 'calendarCreate'],
    ['Nextcloud Calendar: List calendars', 'calendarList'],
    ['Get a form submission from Nextcloud Forms', 'formSubmission'],
    ['Schedule a TaskProcessing AI task', 'special:aiTask'],
    ['Get TaskProcessing task', 'special:dropTask'],
    ['Summarize', 'special:summarize'],
    ['Translate Text', 'special:translate'],
    ['Analyze Image', 'special:analyzeImage'],
    ['Read PDF Form', 'special:readPdfForm'],
    ['Fill forms in a document', 'special:fillForms'],
    ['Create an approval link with approve_links', 'special:approval'],
];

test('all 24 Hub scripts have an entry', () => {
    assert.strictEqual(ALL.length, 24);
    for (const [title, entry] of ALL) assert.strictEqual(hubEntryFor(slugOf(title)), entry, title);
});

test('the version number does not matter', () => {
    const node = (path) => ({ wmId: 'x', kind: 'script', scriptPath: path, inputs: {}, options: { reportOnly: [] } });
    const a = planHub(node('hub/28136/nextcloud/send_a_notification_to_a_user'), ALL_CAPABILITIES);
    const b = planHub(node('hub/1/nextcloud/send_a_notification_to_a_user'), ALL_CAPABILITIES);
    assert.deepStrictEqual(a, b);
    assert.strictEqual(a.tool, 'nextcloud_notifications_send');
});

test('connection inputs are dropped and the rest is renamed or listed', () => {
    const plan = planHub({
        wmId: 'n', kind: 'script', scriptPath: 'hub/1/nextcloud/send_a_notification_to_a_user', options: { reportOnly: [] },
        inputs: {
            nextcloud: { type: 'javascript', expr: 'flow_input.authentication.owner' },
            notificationUserId: { type: 'static', value: 'bob' },
            subject: { type: 'static', value: 'Hi' },
            mystery: { type: 'static', value: 1 },
        },
    }, ALL_CAPABILITIES);
    assert.deepStrictEqual(Object.keys(plan.inputs).sort(), ['shortMessage', 'userId']);
    assert.deepStrictEqual(plan.leftover, ['mystery']);
});

test('Path from Fileid on the trigger file is the trigger path; otherwise the file info action', () => {
    const node = (expr) => ({ wmId: 'p', kind: 'script', scriptPath: 'hub/1/nextcloud/path_from_fileid', options: { reportOnly: [] }, inputs: { fileid: { type: 'javascript', expr } } });
    assert.deepStrictEqual(planHub(node('flow_input.event.node.id'), ALL_CAPABILITIES).path, 'trigger.output.path');
    assert.strictEqual(planHub(node('results.x.id'), ALL_CAPABILITIES).tool, 'nextcloud_file_info');
    assert.strictEqual(planHub(node('results.x.id'), capabilitiesFrom({ fileInfo: false })).kind, 'ai');
});

test('Create Share picks the share action by its fixed share type', () => {
    const node = (shareType) => ({ wmId: 's', kind: 'script', scriptPath: 'hub/1/nextcloud/create_share', options: { reportOnly: [] }, inputs: { shareType, path: { type: 'static', value: '/A' }, shareWith: { type: 'static', value: 'g1' } } });
    assert.strictEqual(planHub(node({ type: 'static', value: 1 }), ALL_CAPABILITIES).tool, 'nextcloud_share_with_group');
    assert.strictEqual(planHub(node({ type: 'static', value: 7 }), ALL_CAPABILITIES).inputs.teamId.value, 'g1');
    assert.strictEqual(planHub(node({ type: 'javascript', expr: 'results.t' }), ALL_CAPABILITIES).kind, 'ai');
});

test('Edit a row finds the column by its title', () => {
    const plan = planHub({
        wmId: 'e', kind: 'script', scriptPath: 'hub/1/nextcloud/edit_a_row_in_a_table_in_nextcloud_tables', options: { reportOnly: [] },
        inputs: { rowId: { type: 'javascript', expr: 'results.r.id' }, value: { type: 'static', value: 'x' }, columnId: { type: 'javascript', expr: 'results.columns.find(c => c.title === "Status")?.id' } },
    }, ALL_CAPABILITIES);
    assert.strictEqual(plan.tool, 'nextcloud_tables_update_row');
    assert.strictEqual(plan.wrapValuesAs, 'Status');
});

test('other apps and paths that are not Hub paths go to the AI builder', () => {
    assert.strictEqual(parseHubPath('f/team/script'), null);
    const plan = planHub({ wmId: 'g', kind: 'script', scriptPath: 'hub/1/github/create_issue', inputs: {}, options: { reportOnly: [] } }, ALL_CAPABILITIES);
    assert.strictEqual(plan.kind, 'ai');
});

test('Analyze Image: with images to AI on, the checklist names read file + an AI step shown the images; off, the OCR text', () => {
    const node = { wmId: 'img', kind: 'script', scriptPath: 'hub/28171/nextcloud/analyze_image', options: { reportOnly: [] }, inputs: { prompt: { type: 'static', value: 'When?' } } };
    const off = planHub(node, ALL_CAPABILITIES);
    assert.strictEqual(ALL_CAPABILITIES.imageAi, false, 'off by default, like the organisation setting');
    assert.strictEqual(off.kind, 'ai');
    assert.match(off.reason, /OCR/);
    assert.doesNotMatch(off.reason, /sourceHandle/);
    const on = planHub(node, capabilitiesFrom({ imageAi: true }));
    assert.strictEqual(on.kind, 'ai');
    assert.match(on.reason, /nextcloud_read_file/);
    assert.match(on.reason, /`images`/);
    assert.match(on.reason, /`sourceHandle`/);
});
