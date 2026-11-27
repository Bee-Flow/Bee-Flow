/**
 * The meeting notes module's ffmpeg callers (../meetingNotes/summaryHelpers, the Scaleway
 * transcode and split): their argument lists stay what fluent-ffmpeg 2.1.3 produced for the same
 * calls, as ffmpeg.test.js holds for the core's callers.
 *
 * Run: cd server && node --test core/media/ffmpeg.meetingNotes.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { _scalewayTranscodeArgs, _scalewaySplitArgs } = require('../meetingNotes/summaryHelpers');

const GOLDEN = {
    mp3: ['-i', '/in/a.m4a', '-y', '-ac', '1', '-ar', '16000', '-f', 'mp3', '/tmp/o.mp3'],
    split: [
        '-i', '/in/a.m4a', '-y', '-ac', '1', '-ar', '16000',
        '-f', 'segment', '-segment_time', '600', '-reset_timestamps', '1',
        '-segment_list', '/tmp/d/list.csv', '-segment_list_type', 'csv',
        '/tmp/d/chunk_%03d.mp3',
    ],
};

test('Scaleway transcode and split arguments match the fluent-ffmpeg chain', () => {
    assert.deepStrictEqual(_scalewayTranscodeArgs('/in/a.m4a', '/tmp/o.mp3'), GOLDEN.mp3);
    assert.deepStrictEqual(_scalewaySplitArgs('/in/a.m4a', '/tmp/d/list.csv', '/tmp/d/chunk_%03d.mp3', 600), GOLDEN.split);
});
