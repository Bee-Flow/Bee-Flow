/**
 * Migration: which draft version is actually live.
 *
 * Adds `published_version` to studio_apps — the definition_version that was
 * frozen into published_definition at publish time, written by
 * studioAppStore.setStudioAppPublished. The draft keeps autosaving into
 * definition/definition_version afterwards, so comparing the two is the only
 * way anything can tell that the live app is behind the editor. IF NOT EXISTS
 * so re-running is safe; rows published before this migration keep NULL
 * ("we don't know", not "up to date") until their next publish.
 */

const { exec } = require('../db');

async function up() {
    await exec(`ALTER TABLE studio_apps ADD COLUMN IF NOT EXISTS published_version INTEGER`);
    console.log('[Migration] studio-app-published-version-2026-08 applied');
}

module.exports = { up };
