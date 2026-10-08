/**
 * Guard for the pinned Learning Center video pack (learning/learnMediaPack.json,
 * generated when a pack is published): when the pin exists it must be valid and
 * every video it pins must be one a lesson plays (a renamed or removed videoId
 * would otherwise ship dead weight). A pack may hold FEWER videos than the
 * lessons use: the player drops a video step it has no file for, so videos can
 * be released in batches. No pin yet = skipped, not failed.
 *
 * Run: cd server && node --test learning/learnMediaPack.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { validatePin } = require('./learnMediaInstall');

const PIN_PATH = path.join(__dirname, 'learnMediaPack.json');
const LESSON_FILES = ['lessons.js', path.join('generated', 'lessons.js')].map((f) => path.join(__dirname, '..', '..', 'agent-hub', 'src', 'components', 'onboarding', f));

/** Every video id the lesson definitions reference (parsed out of the lesson files). */
function lessonVideoIds() {
    const ids = new Set();
    for (const file of LESSON_FILES) {
        if (!fs.existsSync(file)) continue;
        for (const m of fs.readFileSync(file, 'utf8').matchAll(/\bvideoId:\s*["']([^"']+)["']/g)) ids.add(m[1]);
    }
    return [...ids].sort();
}

test('the lesson files are found and use videos (guards the extraction below)', { skip: !fs.existsSync(PIN_PATH) && 'no learnMediaPack.json yet' }, () => {
    assert.ok(lessonVideoIds().length > 0, 'no videoId found in the lesson files: did their location or shape change?');
});

test('learnMediaPack.json is a valid pin whose videos all belong to a lesson', { skip: !fs.existsSync(PIN_PATH) && 'no learnMediaPack.json yet (no pack published for this build): nothing to check' }, () => {
    const pin = validatePin(JSON.parse(fs.readFileSync(PIN_PATH, 'utf8')));
    assert.match(pin.baseUrl, /^https:\/\//, 'the pinned base URL must be https');
    const lessons = new Set(lessonVideoIds());
    const orphans = pin.videoIds.filter((id) => !lessons.has(id));
    assert.deepStrictEqual(orphans, [], `the pinned pack has videos no lesson plays: ${orphans.join(', ')}`);
});
