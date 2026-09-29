/**
 * DE TERMINALE STAPSOORTEN — de canvas-spiegel van één serverlijst.
 *
 * Step types after which NOTHING runs. The canvas has to know this in five
 * separate gestures, and each of them USED to know it as a hand-written
 * `type === 'stop_error'`:
 *
 *   1. mapping/upstream.js          geen variabelengroep — niets kan aan de
 *                                   uitvoer van een terminal binden
 *   2. flow/useStepDrop.js          een stap erachter droppen wordt geweigerd
 *   3. flow/nodeDropTarget.js       een stap ernaast slepen ketent er niet aan
 *   4. flow/useEdgeEditCallbacks.js met de hand een rand tekenen wordt geweigerd
 *   5. flow/nodes/<X>Node.jsx       geen "+"-knop en `sourceConnectable={false}`
 *
 * Vijf literals betekent vijf plekken die uit elkaar kunnen lopen, en de zesde
 * (de validator, aan de serverkant) staat in een andere taal in een andere map.
 * Precies daar zit het risico: kent de canvas een soort niet als terminaal,
 * dan nodigt hij uit om stappen achter de eindstap te plakken die nooit
 * draaien — en de validator zegt er niets over, of andersom, en dan weigert de
 * validator een graaf die de editor zojuist heeft laten tekenen.
 *
 * DE BRON IS DE SERVER. `TERMINAL_STEP_TYPES` in
 * `server/automation/validate/constants.js` is de canonieke lijst; dit is de
 * kopie die de browser kan lezen (geen enkele module kruist de
 * server/agent-hub-grens). De drifttest ernaast — `terminalSteps.test.js` —
 * leest de serverlijst uit de bron en faalt zodra de twee uit elkaar lopen,
 * én zodra er een stapsoort met familie `end` bijkomt die in geen van beide
 * lijsten staat en ook geen expliciete uitzondering heeft.
 *
 * DIT IS GEEN PRESENTATIE. Daarom staat het hier en niet in nodeDefs.js: dat
 * bestand zegt zelf "als de runner of de validator het moet lezen, hoort het
 * hier niet". De VISUELE familie (`end`) en de terminale REGEL zijn twee
 * verschillende dingen, en `layer_output` is het levende bewijs: familie `end`,
 * maar wél connecteerbaar, want een flowlet keert terug naar zijn aanroeper en
 * die loopt door.
 */

/** @type {ReadonlySet<string>} */
export const TERMINAL_STEP_TYPES = new Set([
    // Halts the run with an error message.
    'stop_error',
    // Ends the run and hands the Studio App that started it what to do next.
    'return_to_app',
]);

/**
 * Is this the type of a step after which nothing runs?
 *
 * Takes the TYPE, not the step, so a caller that only has a type string does
 * not have to fabricate an object — and answers false for null/undefined so a
 * lookup that missed narrows to "not terminal, keep the normal rules" rather
 * than throwing inside a drag handler.
 */
export function isTerminalStepType(type) {
    return typeof type === 'string' && TERMINAL_STEP_TYPES.has(type);
}

/** Convenience for the call sites that hold the step object itself. */
export function isTerminalStep(step) {
    return isTerminalStepType(step && step.type);
}
