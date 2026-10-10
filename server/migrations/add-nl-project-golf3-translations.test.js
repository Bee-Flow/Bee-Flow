/**
 * Dutch for the project workspace dialogs, undo and connection status. Both
 * silent failure modes are pinned: a Dutch key with no English key is stored and
 * never read, and an English key with no Dutch value leaves one English sentence
 * in a Dutch page.
 *
 * Run: node --test migrations/add-nl-project-golf3-translations.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS } = require('./add-nl-project-golf3-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

const NEW_KEYS = ['project_home.undo', 'project_home.task_deleted', 'project_home.unsaved_changes', 'project_home.discard', 'project_home.removed_from_project', 'project_home.kb_unlinked', 'project_home.members.removed', 'project_home.message_deleted', 'project_home.connection.polling', 'project_home.connection.stopped', 'project_home.connection.reconnect'];

test('every new English key has a Dutch value', () => {
    const missing = NEW_KEYS.filter((k) => !NL_TRANSLATIONS[k] || !(k in GUI_DEFAULTS));
    assert.deepStrictEqual(missing, []);
});
