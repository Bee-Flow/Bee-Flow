'use strict';
/** Shared fake-Nextcloud harness for the Mail / Talk / Notifications / Activity tool tests. */
const ncClient = require('./nextcloudClient');

const AUTH = 'Bee Flow connector could not reach Nextcloud';

const json = (status, body) => ({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
});

/** handler(url, init) returns a response or throws; returns { out, calls }. */
async function run(exec, tool, args, handler) {
    const original = ncClient.resolveAuth;
    const calls = [];
    ncClient.resolveAuth = async () => ({
        baseUrl: 'https://nc.example.test',
        authError: AUTH,
        uid: 'alice',
        fetch: async (url, init = {}) => {
            calls.push({ url, method: init.method || 'GET' });
            return handler(url, init);
        },
    });
    try {
        return { out: await exec(tool, args, 'u1', {}), calls };
    } finally {
        ncClient.resolveAuth = original;
    }
}

module.exports = { AUTH, json, run };
