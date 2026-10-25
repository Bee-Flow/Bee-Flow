// @typecheck strict
'use strict';

/**
 * The Nextcloud file.* trigger events, split out of declared/nextcloud.js to
 * keep that file small (it is spread into that provider's `events`, in order).
 * Not under declared/ on purpose: everything there is loaded as a provider.
 * Fields are the union of both producers: the webhook sets `id`, `owner` and
 * `actorName`; the activity poller sets `activityId` (see triggerBus/pollers/
 * nextcloud.js and nextcloud-connector/src/webhookListeners.js).
 */
const FILE_EVENTS = [
    {
        id: 'file.new',
        label: 'New file',
        fields: ['id', 'activityId', 'path', 'name', 'extension', 'kind', 'actor', 'actorName', 'owner', 'datetime', 'link'],
        sample: {
            id: 4711,
            actorName: 'Alice',
            owner: 'alice',
            activityId: 12345,
            path: '/Documents/Invoices/Invoice-2026-001.pdf',
            name: 'Invoice-2026-001.pdf',
            extension: 'pdf',
            kind: 'file',
            actor: 'alice',
            datetime: '2026-05-13T09:15:00Z',
            link: 'https://cloud.example.com/f/12345',
        },
        scope: 'org',
        source: {
            kind: 'poller',
        },
    },
    {
        id: 'file.changed',
        label: 'File changed',
        fields: ['id', 'activityId', 'path', 'name', 'extension', 'kind', 'actor', 'actorName', 'owner', 'datetime', 'link'],
        sample: {
            id: 4711,
            actorName: 'Alice',
            owner: 'alice',
            activityId: 12346,
            path: '/Documents/Invoices/Invoice-2026-001.pdf',
            name: 'Invoice-2026-001.pdf',
            extension: 'pdf',
            kind: 'file',
            actor: 'alice',
            datetime: '2026-05-13T10:20:00Z',
            link: 'https://cloud.example.com/f/12345',
        },
        scope: 'org',
        source: {
            kind: 'poller',
        },
    },
    {
        id: 'file.deleted',
        label: 'File deleted',
        fields: ['id', 'activityId', 'path', 'name', 'extension', 'kind', 'actor', 'actorName', 'owner', 'datetime', 'link'],
        sample: {
            id: 4711,
            actorName: 'Alice',
            owner: 'alice',
            activityId: 12348,
            path: '/Documents/Old/Draft.docx',
            name: 'Draft.docx',
            extension: 'docx',
            kind: 'file',
            actor: 'alice',
            datetime: '2026-05-13T11:30:00Z',
            link: 'https://cloud.example.com/f/12348',
        },
        scope: 'org',
        source: {
            kind: 'push',
        },
    },
    {
        id: 'file.renamed',
        label: 'File renamed',
        fields: ['id', 'activityId', 'path', 'oldPath', 'name', 'extension', 'kind', 'actor', 'actorName', 'owner', 'datetime', 'link'],
        sample: {
            id: 4711,
            actorName: 'Alice',
            owner: 'alice',
            activityId: 12349,
            path: '/Documents/Invoices/Invoice-2026-001.pdf',
            oldPath: '/Documents/Invoices/draft.pdf',
            name: 'Invoice-2026-001.pdf',
            extension: 'pdf',
            kind: 'file',
            actor: 'alice',
            datetime: '2026-05-13T11:45:00Z',
            link: 'https://cloud.example.com/f/12345',
        },
        scope: 'org',
        source: {
            kind: 'push',
        },
    },
];

module.exports = { FILE_EVENTS };
