// @typecheck
/**
 * Transcription Store — PostgreSQL-backed meeting transcription history.
 *
 * Stores transcription results so they can be listed, viewed, renamed,
 * deleted, and published to org groups (mirrors the KB / agent publish
 * model). Read access:
 *   - Owner always
 *   - Published to org: same-org member sees it
 *   - Published with shared_groups: only members of one of those groups
 *   - Filed into a project (project_id): any member of that project, any role
 * Writes stay with the owner, whoever else may read.
 *
 * The parts live in stores/transcription/: schema.js (DDL + init), acl.js
 * (the read rule), reads.js and lookups.js, writes.js (sealed content writes),
 * lifecycle.js (reaper, publish, delete), projects.js (project membership),
 * rowShape.js, jsonArrays.js and artifactWindow.js. This file is the store's
 * one public entry, and the one place that requires the two dependencies that
 * sit in the server's big import cycle (transcriptCrypto, projectRole): it
 * hands them to the parts, so the split does not grow that cycle.
 */

// Content-column encryption for this store — policy, key, and the two derived
// columns the list query needs. See stores/transcriptCrypto.js.
const transcriptCrypto = require('./transcriptCrypto');
const { projectRoleOf } = require('./lib/projectRole');
const { initDB } = require('./transcription/schema');
const { createRowShape } = require('./transcription/rowShape');
const { createProjectAcl } = require('./transcription/acl');
const { createReads } = require('./transcription/reads');
const { createWrites } = require('./transcription/writes');
const lookups = require('./transcription/lookups');
const lifecycle = require('./transcription/lifecycle');
const projects = require('./transcription/projects');

const { shapeRow, mapRow } = createRowShape({ transcriptCrypto });
const { readableThroughProject, canReadTranscription } = createProjectAcl({ projectRoleOf });
const reads = createReads({ transcriptCrypto, shapeRow, mapRow, readableThroughProject });
const writes = createWrites({ transcriptCrypto });

module.exports = {
    createTranscription: writes.createTranscription,
    getTranscriptions: reads.getTranscriptions,
    getTranscription: reads.getTranscription,
    listByTag: reads.listByTag,
    canReadTranscription,
    getTranscriptionsByAudioPaths: lookups.getTranscriptionsByAudioPaths,
    getTranscriptionBySourceUri: lookups.getTranscriptionBySourceUri,
    getTranscriptionByTalkRoomToken: lookups.getTranscriptionByTalkRoomToken,
    getTranscriptionByMeetMeetingCode: lookups.getTranscriptionByMeetMeetingCode,
    getSeriesPrevious: lookups.getSeriesPrevious,
    updateTranscription: writes.updateTranscription,
    claimForProcessing: writes.claimForProcessing,
    finishProcessing: writes.finishProcessing,
    timeoutStuckTranscriptions: lifecycle.timeoutStuckTranscriptions,
    setPublished: lifecycle.setPublished,
    deleteTranscription: lifecycle.deleteTranscription,
    setTranscriptionProject: projects.setTranscriptionProject,
    detachTranscriptionFromProject: projects.detachTranscriptionFromProject,
    listProjectMeetings: projects.listProjectMeetings,
    countProjectMeetings: projects.countProjectMeetings,
    clearProjectFromTranscriptions: projects.clearProjectFromTranscriptions,
    // Awaitbare init-ingang voor migrateDb (memoised — zelfde promise als de load-time init).
    initDB,
};
