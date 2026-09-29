'use strict';

/**
 * Buildstempel — de fallback en de sleutelhulp.
 *
 * buildInfo leest APP_BUILD_SHA één keer, bij require. Elke case evict de
 * module dus uit require.cache en laadt hem vers onder de gewenste env.
 *
 * Run: cd server && node --test --test-force-exit utils/buildInfo.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const MOD = require.resolve('./buildInfo');

function freshBuildInfo(sha) {
    delete require.cache[MOD];
    if (sha === undefined) delete process.env.APP_BUILD_SHA;
    else process.env.APP_BUILD_SHA = sha;
    try {
        return require(MOD);
    } finally {
        delete require.cache[MOD];
        delete process.env.APP_BUILD_SHA;
    }
}

test('zonder APP_BUILD_SHA valt de stempel terug op "dev"', () => {
    const info = freshBuildInfo(undefined);
    assert.strictEqual(info.APP_BUILD_SHA, 'dev');
});

test('een lege string telt als afwezig — de Dockerfile-default is ""', () => {
    // Een kale `docker build` zonder build-arg bakt ENV APP_BUILD_SHA="" in het
    // image; ook dan moet de stempel bruikbaar (niet-leeg) zijn.
    const info = freshBuildInfo('');
    assert.strictEqual(info.APP_BUILD_SHA, 'dev');
});

test('de door CI ge-injecteerde sha wordt letterlijk overgenomen', () => {
    const info = freshBuildInfo('0123abcd0123abcd0123abcd0123abcd0123abcd');
    assert.strictEqual(info.APP_BUILD_SHA, '0123abcd0123abcd0123abcd0123abcd0123abcd');
});

test('buildKey vlecht de buildversie in de prefix', () => {
    const info = freshBuildInfo('abc123');
    assert.strictEqual(info.buildKey('_ent:u1:o2'), '_ent:u1:o2:babc123');
});

test('twee builds munten via buildKey nooit dezelfde sleutel', () => {
    const a = freshBuildInfo('sha-oud').buildKey('_lic:u1');
    const b = freshBuildInfo('sha-nieuw').buildKey('_lic:u1');
    assert.notStrictEqual(a, b);
});
