/**
 * The Dutch for the second collaboration round, part one (editing together,
 * versions, comments, what changed, the AI that joins by itself, notebooks).
 * The rules themselves live in testUtils/nlCatalogueChecks.js; this file says
 * which keys the catalogue answers for.
 *
 * Run: node --test migrations/add-nl-collaboration-wave2-editor-versions-translations.test.js
 */

const { registerNlCatalogueChecks } = require('../testUtils/nlCatalogueChecks');
const catalogue = require('./add-nl-collaboration-wave2-editor-versions-translations');

registerNlCatalogueChecks({
    name: 'add-nl-collaboration-wave2-editor-versions-translations',
    catalogue,
    // project_home and project_chat are shared with the first round's
    // catalogue, whose own test demands Dutch for every key of both; notebooks
    // held no Dutch before this round, so only the keys listed here are
    // claimed there.
    mayHold: ['editor.', 'versions.', 'comments.', 'project_participation.', 'project_home.', 'project_chat.', 'notebooks.'],
    mustCover: ['editor.', 'versions.', 'comments.', 'project_participation.', 'project_home.since.'],
    declaredFor: {
        'editor.link_dialog': 'Link',
        'editor.presence_live': 'Live',
        'editor.presence_offline': 'Offline',
        'editor.shortcuts_group_document': 'Document',
        'versions.ai_chip': 'AI',
        'versions.atom.diagram': 'Diagram',
        'versions.who.ai': 'AI',
        'comments.ai_badge': 'AI',
        'project_home.activity.ai_name': 'AI',
        'project_home.activity.quoted': '“{title}”',
        'notebooks.uploads_label': 'Uploads',
        'notebooks.in_project': 'In {name}',
    },
});
