/**
 * One line on the run's warnings (`runState._templateWarnings`), once.
 * Loop bodies and layers share the parent's array by reference, so the same
 * line is not appended per iteration.
 */
'use strict';

/** @param {{ _templateWarnings?: unknown } | null | undefined} runState @param {string} line */
function noteRunWarning(runState, line) {
    const list = runState && runState._templateWarnings;
    if (Array.isArray(list) && !list.includes(line)) list.push(line);
}

module.exports = { noteRunWarning };
