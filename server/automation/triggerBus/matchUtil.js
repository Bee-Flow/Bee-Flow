'use strict';

/** Case-insensitive substring test shared by the trigger filter matchers; false unless both are strings. */
function containsCI(haystack, needle) {
    if (typeof haystack !== 'string' || typeof needle !== 'string') return false;
    return haystack.toLowerCase().includes(needle.toLowerCase());
}

module.exports = { containsCI };
