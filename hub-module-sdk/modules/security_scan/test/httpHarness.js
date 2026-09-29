/**
 * Tiny HTTP harness for driving a module router end-to-end with a fake session.
 *
 * Mounts the router in a throwaway express app on an ephemeral loopback port,
 * injecting `req.session` (the loader forwards the live req in-product), and
 * returns the base URL + a close(). Tests hit it with the global fetch.
 */

'use strict';

const http = require('node:http');
const express = require('express');

/**
 * @param {import('express').Router} router
 * @param {{ session?: object }} [opts]
 * @returns {Promise<{ base:string, close:()=>Promise<void> }>}
 */
function serve(router, { session } = {}) {
    const app = express();
    app.use((req, _res, next) => { req.session = session || {}; next(); });
    app.use(router);
    const server = http.createServer(app);
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                base: `http://127.0.0.1:${port}`,
                close: () => new Promise((r) => server.close(r)),
            });
        });
    });
}

module.exports = { serve };
