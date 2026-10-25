// Test kit for the agent chat door's test suites (chat.testAs / chat.testChat):
// the mocked requires of ./chat and of core/agentRuntime/testAs, the resolve hook,
// the router and a `dispatch(body)` that runs one POST through it.
//
//   const { dispatch } = installChatKit(fx, { prefix: 'agent-chat-x' });
//
// `fx` is the caller's fixture object and is read live by the mocks:
//   userId, agent, canModify, modifyThrows, groups, ownGroups, metadata,
//   groupThrows (optional: getGroup throws when truthy),
//   conversationReads (optional: counted when it is a number).
// `terminalErrors: true` sends a router error through terminalErrorHandler
// (so the test sees the HTTP answer); otherwise it rejects dispatch.
//
// Not a test file: required by *.test.js next to it. No test cases here.

'use strict';

const test = require('node:test');
const Module = require('module');

function installChatKit(fx, { prefix, terminalErrors = false }) {
    const MOCKS = {
        '../../stores/agentStore': {
            getAgent: async () => (fx.agent ? { ...fx.agent } : null),
            getConversationById: async () => { if (typeof fx.conversationReads === 'number') fx.conversationReads++; return { id: 'c1', title: 'Existing', messages: [] }; },
            updateConversationTitle: async () => {},
        },
        '../../core/agentRuntime': {
            chatWithAgentStream: async (agentId, userId, message, userAuth, onEvent, history, metadata) => {
                fx.metadata.push(metadata);
                return { conversationId: 'c1', conversationLength: 2 };
            },
            generateChatTitle: async () => 'Title',
        },
        '../../core/aiAgent': { getAIConfig: async () => ({}), getProviderForModel: async () => ({}) },
        '../../stores/configStore': { get: async () => null, set: async () => {} },
        '../../auth': {
            requirePermission: () => (req, res, next) => next(),
            requireAuth: (req, res, next) => next(),
            resolveUserOrgIds: async () => new Set(['org1']),
        },
        '../../stores/memoryStore': {},
        '../../utils/routeHelpers': {
            getEffectiveUserId: () => fx.userId,
            getUserAuth: async () => ({ userId: fx.userId, userOrgId: 'org1', session: {} }),
        },
        '../../utils/perUserRateLimit': { perUserRateLimit: () => (req, res, next) => next() },
        '../../stores/userStore': { getUser: async () => ({ id: fx.userId, organizationId: 'org1', groups: [] }) },
        '../../stores/usageStore': { logUsage: async () => {} },
        '../../core/entitlements/limits': {
            checkSubscriptionLimits: async () => null,
            checkResourceLimits: async () => null,
        },
        '../../core/http/sseHelpers': {
            setupSSE: (res) => {
                res.events = [];
                return {
                    abortController: new AbortController(),
                    markEnded: () => {},
                    sendEvent: (event, data) => { res.events.push({ event, data }); },
                };
            },
            sendSSEError: (res, err) => { res.body = { error: err }; res.statusCode = 402; },
            persistAndTitle: async () => {},
            getOrCreateAgentConversation: async () => ({ id: 'c1' }),
        },
        './crud': {
            canModifyAgent: async () => {
                if (fx.modifyThrows) throw new Error('permission store down');
                return fx.canModify;
            },
            canReadAgent: async () => true,
        },
    };

    const realAudience = require('../../auth/audience');
    const TEST_AS_MOCKS = {
        '../../stores/userStore': {
            getGroup: async (id) => {
                if (fx.groupThrows) throw new Error('groups table unreachable');
                return fx.groups[id] || null;
            },
        },
        '../../auth/audience': {
            resolveUserGroups: async () => fx.ownGroups,
            canSeePublished: realAudience.canSeePublished,
        },
    };

    const MOCK_IDS = {};
    for (const [request, exportsObj] of Object.entries(MOCKS)) {
        const mockId = `mock:${prefix}:${request}`;
        MOCK_IDS[request] = mockId;
        require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
    }
    const TEST_AS_IDS = {};
    for (const [request, exportsObj] of Object.entries(TEST_AS_MOCKS)) {
        const mockId = `mock:${prefix}:inner:${request}`;
        TEST_AS_IDS[request] = mockId;
        require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
    }

    const originalResolve = Module._resolveFilename;
    Module._resolveFilename = function (request, parent, ...rest) {
        if (parent && /agents[\\/]chat\.js$/.test(parent.filename)
            && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
            return MOCK_IDS[request];
        }
        if (parent && /agentRuntime[\\/]testAs\.js$/.test(parent.filename)
            && Object.prototype.hasOwnProperty.call(TEST_AS_IDS, request)) {
            return TEST_AS_IDS[request];
        }
        return originalResolve.call(this, request, parent, ...rest);
    };


    const router = require('./chat');
    test.after(() => { Module._resolveFilename = originalResolve; });

    function dispatch(body) {
        return new Promise((resolve, reject) => {
            const request = {
                method: 'POST', url: '/a1/chat/stream', originalUrl: '/a1/chat/stream',
                path: '/a1/chat/stream', body, query: {}, headers: {},
                session: { user: { id: fx.userId } },
                get() { return undefined; },
            };
            const res = {
                statusCode: 200, events: [], writableEnded: false,
                status(c) { this.statusCode = c; return this; },
                json(b) { this.body = b; resolve(this); return this; },
                send(b) { this.body = b; resolve(this); return this; },
                end() { this.writableEnded = true; resolve(this); return this; },
                setHeader() {}, flushHeaders() {}, write() {}, on() {},
            };
            router(request, res, (err) => {
                if (err && terminalErrors) {
                    require('../../core/http/terminalErrorHandler').terminalErrorHandler(err, request, res, reject);
                } else {
                    reject(err || new Error('fell through router'));
                }
            });
        });
    }

    return { router, dispatch };
}

module.exports = { installChatKit };
