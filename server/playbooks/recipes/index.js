'use strict';

const invoiceTracker = require('./invoiceTracker');

const RECIPES = Object.freeze({ [invoiceTracker.RECIPE_ID]: invoiceTracker });

function getRecipe(id) {
    return (typeof id === 'string' && RECIPES[id]) || null;
}

/**
 * The built-in recipes OFFERED in the New dialog, as documents in the
 * interface language.
 *
 * Empty since 2026-09-16 (owner): a playbook is described in your own words
 * and the AI writes the phases — there is no menu of canned ones to pick from.
 * The modules stay: playbooks built from one are still on file, and
 * `getRecipe` has to resolve their `recipeId` to compose their briefs and name
 * their phases. Put an id back in OFFERED to list it again.
 */
const OFFERED = Object.freeze([]);

function listRecipes(locale) {
    return OFFERED
        .map((id) => RECIPES[id])
        .filter(Boolean)
        .map((r) => (typeof r.toDocument === 'function' ? r.toDocument(locale) : { id: r.RECIPE_ID, title: r.title, description: r.description, phases: r.PHASE_KEYS.map((key) => ({ key, kind: key, label: key })) }));
}

module.exports = { RECIPES, OFFERED, getRecipe, listRecipes };
