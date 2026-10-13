/**
 * CommonJS v2 host mock for the security_scan module tests.
 *
 * The surface lives in the SDK's shared test kit (hub-module-sdk/test-kit/hostMock.js);
 * this file binds the module's defaults: its own express, moduleId
 * 'security_scan', a limits.checkSubscription that resolves to null, and a
 * silent logger. Inject overrides via opts to assert a module's calls
 * (db/ai/usage/limits/storage/webpages/net/log stubs).
 */

'use strict';

const express = require('express');
const {
    createHostMockFactory,
    makeDbMock,
    defaultIsPrivateTarget,
    silentLog,
} = require('../../../test-kit/hostMock.js');

const makeHostMock = createHostMockFactory({
    express,
    moduleId: 'security_scan',
    subscriptionResult: () => null,
    log: silentLog,
});

module.exports = { makeHostMock, makeDbMock, defaultIsPrivateTarget };
