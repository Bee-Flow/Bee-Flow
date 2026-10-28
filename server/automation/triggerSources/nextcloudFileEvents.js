// @typecheck strict
'use strict';

/**
 * The Nextcloud file.* trigger events, split out of declared/nextcloud.js to
 * keep that file small (it is spread into that provider's `events`, in order).
 * Not under declared/ on purpose: everything there is loaded as a provider.
 * The fields ARE the canonical file payload both producers deliver (the
 * connector's webhook and the activity poller go through
 * triggerBus/ncPayload.mts), so this list cannot drift from what arrives. A
 * key the producer cannot know is null: `activityId` on a webhook delivery,
 * `actorName` from the poller, `id` on a delete.
 */
const { FILE_FIELDS } = require('../triggerBus/ncPayload.mts');

const FIELDS = [...FILE_FIELDS];
const RENAMED_FIELDS = [...FILE_FIELDS.slice(0, 3), 'oldPath', ...FILE_FIELDS.slice(3)];
const FILE_EVENTS = [
    {
        id: 'file.new',
        label: 'New file',
        fields: FIELDS,
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
            isOwnAction: false,
        },
        scope: 'org',
        source: {
            kind: 'poller',
        },
    },
    {
        id: 'file.changed',
        label: 'File changed',
        fields: FIELDS,
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
            isOwnAction: false,
        },
        scope: 'org',
        source: {
            kind: 'poller',
        },
    },
    {
        id: 'file.deleted',
        label: 'File deleted',
        fields: FIELDS,
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
            isOwnAction: false,
        },
        scope: 'org',
        source: {
            kind: 'push',
        },
    },
    {
        id: 'file.renamed',
        label: 'File renamed',
        fields: RENAMED_FIELDS,
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
            isOwnAction: false,
        },
        scope: 'org',
        source: {
            kind: 'push',
        },
    },
];

module.exports = { FILE_EVENTS };
