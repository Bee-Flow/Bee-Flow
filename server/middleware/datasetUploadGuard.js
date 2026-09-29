// @typecheck
/**
 * Dataset upload guard — the intake policy for LARGE dataset parts.
 *
 * Sits next to uploadGuard.js but is deliberately a different shape: uploadGuard
 * buffers ONE complete ≤25 MB file and scans it whole; a dataset arrives as a
 * sequence of bounded raw parts, so policy splits in two:
 *
 *   - HERE (part 0 only): the head must LOOK like what was declared — gzip
 *     magic, or plain text opening with `##fileformat=VCF`. Plus the EICAR
 *     probe, mirroring scanBuffer's test hook so the quarantine path stays
 *     testable end to end.
 *   - AT INGEST (jobs/datasetIngest.js): the real gate. Every byte is parsed
 *     and re-encoded; a file that does not parse as sorted VCF never becomes
 *     queryable, and the raw upload is deleted on success. That is the
 *     'structural' AV verdict on the manifest — see the job header.
 */

const express = require('express');
const { _sniffFamily, EICAR } = require('./uploadGuard');

/** Raw-body parser for one part. `partSize` + slack, any content type. */
function datasetPartBody(partSizeBytes) {
    return express.raw({ type: '*/*', limit: partSizeBytes + 1024 * 1024 });
}

/**
 * Policy check for the FIRST part's head bytes.
 * @returns {{ok:true, family:'gzip'|'text'} | {ok:false, reason:string}}
 */
function sniffDatasetHead(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        return { ok: false, reason: 'the first part is empty' };
    }
    // Same EICAR probe scanBuffer uses (first bytes), so upload tests can
    // exercise the refusal path without a real AV hook.
    if (buffer.subarray(0, 256).toString('latin1').includes(EICAR)) {
        return { ok: false, reason: 'the file failed the malware probe' };
    }
    const family = _sniffFamily(buffer);
    if (family === 'gzip') return { ok: true, family: 'gzip' };
    if (family === 'text' && buffer.subarray(0, 64).toString('utf8').startsWith('##fileformat=VCF')) {
        return { ok: true, family: 'text' };
    }
    return {
        ok: false,
        reason: family === 'text'
            ? 'the file is text but does not start with ##fileformat=VCF'
            : `a dataset upload must be a .vcf or .vcf.gz file (this sniffs as "${family}")`,
    };
}

module.exports = { datasetPartBody, sniffDatasetHead };
