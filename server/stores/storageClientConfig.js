// @typecheck strict
/**
 * Configuration of the ONE shared S3 client (stores/storageStore.js).
 */

/**
 * Timeouts and pool size. Without them a leaked or stalled GetObject keeps its
 * socket for ever, the default pool of 50 fills up and every storage call in the
 * process waits without end. socketTimeout is the real idle timeout (it also
 * covers a stalled body, so a long but moving download continues). requestTimeout
 * is deliberately NOT set: in @smithy/node-http-handler it only watches for the
 * response headers and merely warns.
 */
function s3RequestHandlerOptions() {
    const num = (/** @type {string} */ name, /** @type {number} */ fallback) => {
        const n = Number(process.env[name]);
        return Number.isFinite(n) && n > 0 ? n : fallback;
    };
    const maxSockets = num('STORAGE_MAX_SOCKETS', 100);
    return {
        connectionTimeout: num('STORAGE_CONNECT_TIMEOUT_MS', 5000),
        socketTimeout: num('STORAGE_SOCKET_TIMEOUT_MS', 60000),
        httpAgent: { maxSockets },
        httpsAgent: { maxSockets },
    };
}

/** @param {string} endpoint @param {string} accessKeyId @param {string} secretAccessKey */
function s3ClientConfig(endpoint, accessKeyId, secretAccessKey) {
    return {
        endpoint,
        region: 'us-east-1', // Required by SDK but ignored by RustFS
        credentials: { accessKeyId, secretAccessKey },
        forcePathStyle: true, // Required for non-AWS S3 (RustFS, MinIO)
        requestHandler: s3RequestHandlerOptions(),
    };
}

module.exports = { s3RequestHandlerOptions, s3ClientConfig };
