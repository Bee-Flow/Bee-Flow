/**
 * What the Meeting Notes ingest modules share: the error a provider wrapper
 * maps to an HTTP answer, and the best-effort removal of a scratch file.
 * ingestRecordingCore.js re-exports IngestError for its callers.
 */

'use strict';

const fs = require('fs');
const log = require('../../telemetry/log');

class IngestError extends Error {
    constructor(message, { code = 'ingest_failed', status = 500 } = {}) {
        super(message);
        this.name = 'IngestError';
        this.code = code;
        this.status = status;
    }
}

function safeUnlink(p) { try { fs.unlinkSync(p); } catch (_) { log.debug('file already gone', _); } }

module.exports = { IngestError, safeUnlink };
