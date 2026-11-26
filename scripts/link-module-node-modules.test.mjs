import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { plannedLinks, linkState, makeLink } from './link-module-node-modules.mjs';

function sandbox() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modlink-'));
    fs.mkdirSync(path.join(root, 'server/node_modules'), { recursive: true });
    fs.mkdirSync(path.join(root, 'agent-hub/node_modules'), { recursive: true });
    return root;
}

test('no modules/ directory: nothing to link', () => {
    const root = sandbox();
    assert.deepEqual(plannedLinks(root), []);
    fs.mkdirSync(path.join(root, 'modules'));
    assert.deepEqual(plannedLinks(root), []);
});

test('links server and frontend roots, idempotently, with a relative link', () => {
    const root = sandbox();
    fs.mkdirSync(path.join(root, 'modules/a/server'), { recursive: true });
    fs.mkdirSync(path.join(root, 'modules/a/frontend'), { recursive: true });
    fs.mkdirSync(path.join(root, 'modules/b/server'), { recursive: true });
    const links = plannedLinks(root);
    assert.equal(links.length, 3);
    for (const l of links) assert.equal(linkState(l), 'missing');
    for (const l of links) assert.equal(makeLink(l), 'created');
    for (const l of links) assert.equal(makeLink(l), 'ok');
    if (process.platform !== 'win32') {
        assert.equal(fs.readlinkSync(path.join(root, 'modules/a/server/node_modules')), path.join('..', '..', '..', 'server', 'node_modules'));
    }
});

test('a link that points elsewhere is wrong and gets replaced; a missing target is skipped', () => {
    const root = sandbox();
    fs.mkdirSync(path.join(root, 'modules/a/server'), { recursive: true });
    fs.mkdirSync(path.join(root, 'modules/a/frontend'), { recursive: true });
    fs.rmSync(path.join(root, 'agent-hub/node_modules'), { recursive: true });
    const [link] = plannedLinks(root);
    assert.equal(plannedLinks(root).length, 1);
    fs.mkdirSync(path.join(root, 'elsewhere'));
    fs.symlinkSync(path.join(root, 'elsewhere'), link.link);
    assert.equal(linkState(link), 'wrong');
    assert.equal(makeLink(link), 'created');
    assert.equal(linkState(link), 'ok');
});

test('a real directory in place of the link is wrong and never removed', () => {
    const root = sandbox();
    fs.mkdirSync(path.join(root, 'modules/a/server/node_modules'), { recursive: true });
    const [link] = plannedLinks(root);
    assert.equal(linkState(link), 'wrong');
    assert.throws(() => makeLink(link), /not a link/);
});
