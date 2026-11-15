/**
 * The Nextcloud call matcher (ocsMatcher.mts): a custom script with one
 * recognisable OCS / WebDAV call becomes the matching action; anything else
 * is not a match.
 *
 * Run: cd server && node --test automation/importers/windmill/ocsMatcher.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

const { planOcs } = require('./ocsMatcher.mts');
const { ALL_CAPABILITIES, capabilitiesFrom } = require('./capabilities.mts');

const inputs = (...names) => Object.fromEntries(names.map((n) => [n, { type: 'javascript', expr: `results.${n}` }]));

test('MKCOL on the user\'s files is create_folder', () => {
    const src = `import axios from "axios";
export async function main(nextcloud: RT.Nextcloud, path: string) {
  return (await axios.request({ method: "MKCOL", url: \`/remote.php/dav/files/\${nextcloud.userId}/\${path}\`, baseURL: nextcloud.baseUrl })).data;
}`;
    const plan = planOcs(src, inputs('path'), ALL_CAPABILITIES);
    assert.strictEqual(plan.tool, 'nextcloud_create_folder');
    assert.deepStrictEqual(plan.inputs.path, { type: 'javascript', expr: 'results.path' });
});

test('COPY with a Destination header is nextcloud_copy', () => {
    const src = `import axios from "axios";
export async function main(nc: RT.Nextcloud, from: string, to: string) {
  await axios.request({ method: "COPY", url: \`/remote.php/dav/files/\${nc.userId}/\${from}\`, baseURL: nc.baseUrl,
    headers: { Destination: \`\${nc.baseUrl}/remote.php/dav/files/\${nc.userId}/\${to}\` } });
}`;
    const plan = planOcs(src, inputs('from', 'to'), ALL_CAPABILITIES);
    assert.strictEqual(plan.tool, 'nextcloud_copy');
    assert.deepStrictEqual(Object.keys(plan.inputs), ['source', 'destination']);
});

test('a tag relation PUT is tag_file; a user lookup is the user action', () => {
    const tag = `import axios from "axios";
export async function main(ncResource: RT.Nextcloud, fileId: number, tagId: number) {
  const base = ncResource.baseUrl.replace(/\\/$/, "");
  return axios.put(\`\${base}/remote.php/dav/systemtags-relations/files/\${fileId}/\${tagId}\`, "");
}`;
    assert.strictEqual(planOcs(tag, inputs('fileId', 'tagId'), ALL_CAPABILITIES).tool, 'nextcloud_tag_file');
    const user = `export async function main(ncResource: RT.Nextcloud, userId: string) {
  const r = await fetch(\`\${ncResource.baseUrl}/ocs/v2.php/cloud/users/\${userId}?format=json\`, { headers: { "OCS-APIRequest": "true" } });
  return (await r.json()).ocs.data;
}`;
    assert.strictEqual(planOcs(user, inputs('userId'), ALL_CAPABILITIES).tool, 'nextcloud_get_user');
    assert.strictEqual(planOcs(user, inputs('userId'), capabilitiesFrom({ getUser: false })), null);
});

test('another single OCS call is the generic Nextcloud request', () => {
    const src = `import createClient from "openapi-fetch";
export async function main(nextcloud: RT.Nextcloud, tableId: number, data: object) {
  const client = createClient({ baseUrl: nextcloud.baseUrl });
  return client.POST("/index.php/apps/tables/api/1/tables/{tableId}/rows", { params: { path: { tableId: tableId } }, body: { data: data } });
}`;
    const plan = planOcs(src, inputs('tableId', 'data'), ALL_CAPABILITIES);
    assert.strictEqual(plan.tool, 'nextcloud_request');
    assert.deepStrictEqual(plan.fixed, { path: '/index.php/apps/tables/api/1/tables/{{tableId}}/rows' });
    assert.deepStrictEqual(Object.keys(plan.objects.body), ['data']);
    assert.strictEqual(planOcs(src, inputs('tableId', 'data'), capabilitiesFrom({ request: false })), null);
});

test('two calls, a loop, an outside fetch or a computed URL are not a match', () => {
    const two = `export async function main(nc: RT.Nextcloud, a: string) {
  await fetch(\`\${nc.baseUrl}/ocs/v2.php/cloud/users/\${a}\`);
  await fetch(\`\${nc.baseUrl}/ocs/v2.php/cloud/groups/\${a}\`);
}`;
    const loop = `export async function main(nc: RT.Nextcloud, ids: string[]) {
  for (const id of ids) await fetch(\`\${nc.baseUrl}/ocs/v2.php/cloud/users/\${id}\`);
}`;
    const outside = `export async function main(nc: RT.Nextcloud, a: string) {
  await fetch("https://api.example.com/x");
  return fetch(\`\${nc.baseUrl}/ocs/v2.php/cloud/users/\${a}\`);
}`;
    const computed = `export async function main(nc: RT.Nextcloud, a: string) {
  const url = nc.baseUrl + "/ocs/v2.php/cloud/users/" + a;
  return fetch(url);
}`;
    for (const src of [two, loop, outside, computed]) assert.strictEqual(planOcs(src, inputs('a', 'ids'), ALL_CAPABILITIES), null);
});
