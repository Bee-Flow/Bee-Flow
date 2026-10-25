import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { convertSource, loadAcorn } from './console-to-log.mjs';

const acorn = loadAcorn();
const skip = !acorn && 'no acorn installed (server/ or nextcloud-connector/)';
const opts = { requirePath: './log' };

test('console calls become log calls, the require lands after the last require', { skip }, () => {
    const src = "'use strict';\nconst a = require('a');\nconst b = require('b');\n\nfunction f() {\n    console.log('x');\n    console.warn('[T] y', 1);\n    console.error(e);\n    console.debug('d');\n}\n";
    const r = convertSource(acorn, src, opts);
    assert.strictEqual(r.calls, 4);
    assert.strictEqual(r.code, "'use strict';\nconst a = require('a');\nconst b = require('b');\nconst log = require('./log');\n\nfunction f() {\n    log.info('x');\n    log.warn('[T] y', 1);\n    log.error(e);\n    log.debug('d');\n}\n");
});

test('strings, comments, templates and other console members are left alone', { skip }, () => {
    const src = "const a = require('a');\n// console.log('no')\nconst s = \"console.warn('no')\";\nconst t = `console.error(${a})`;\nconsole.table(a);\nconst c = console;\n";
    const r = convertSource(acorn, src, opts);
    assert.strictEqual(r.calls, 0);
    assert.strictEqual(r.code, src);
});

test('a console call above the requires does not misplace the insert', { skip }, () => {
    const src = "console.warn('early');\nconst a = require('a');\nconsole.log('x');\n";
    const r = convertSource(acorn, src, opts);
    assert.match(r.code, /^log\.warn\('early'\);\nconst a = require\('a'\);\nconst log = require\('\.\/log'\);\nlog\.info\('x'\);\n$/);
});

test('a file without requires gets the require first; one that binds `log` is skipped', { skip }, () => {
    const bare = convertSource(acorn, "console.log('x');\n", opts);
    assert.strictEqual(bare.code, "const log = require('./log');\nlog.info('x');\n");
    const clash = convertSource(acorn, "const log = (m) => m;\nconsole.log('x');\n", opts);
    assert.strictEqual(clash.calls, 0);
    assert.match(clash.skipped, /binds `log`/);
    const param = convertSource(acorn, "function f(log) { console.log('x'); }\n", opts);
    assert.match(param.skipped, /binds `log`/);
});

test('the CLI converts a directory, leaves the logger alone and --dry writes nothing', { skip }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2l-'));
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'log.js'), "console.log('the sink');\n");
    fs.writeFileSync(path.join(dir, 'a.js'), "'use strict';\nconsole.warn('a');\n");
    fs.writeFileSync(path.join(dir, 'sub', 'b.js'), "const x = require('x');\nconsole.error('b');\n");
    const script = fileURLToPath(new URL('./console-to-log.mjs', import.meta.url));
    const dry = JSON.parse(execFileSync(process.execPath, [script, dir, '--dry'], { encoding: 'utf8' }));
    assert.strictEqual(dry.converted.length, 2);
    assert.match(fs.readFileSync(path.join(dir, 'a.js'), 'utf8'), /console\.warn/);
    execFileSync(process.execPath, [script, dir], { encoding: 'utf8' });
    assert.strictEqual(fs.readFileSync(path.join(dir, 'log.js'), 'utf8'), "console.log('the sink');\n");
    assert.strictEqual(fs.readFileSync(path.join(dir, 'a.js'), 'utf8'), "'use strict';\nconst log = require('./log');\nlog.warn('a');\n");
    assert.strictEqual(fs.readFileSync(path.join(dir, 'sub', 'b.js'), 'utf8'), "const x = require('x');\nconst log = require('../log');\nlog.error('b');\n");
});
