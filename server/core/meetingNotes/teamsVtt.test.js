const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTeamsVtt } = require('./teamsVtt');

test('entities in a cue are decoded once: "&amp;lt;" is the text "&lt;"', () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:04.500\n<v Ann &amp; Bob>write &amp;lt;br&amp;gt; for a break, R&amp;D &lt;3</v>\n';
    const { segments } = parseTeamsVtt(vtt);
    assert.equal(segments.length, 1);
    assert.equal(segments[0].text, 'write &lt;br&gt; for a break, R&D <3');
    assert.equal(segments[0].speakerId, 'Ann & Bob');
    assert.equal(segments[0].start, 1);
    assert.equal(segments[0].end, 4.5);
});
