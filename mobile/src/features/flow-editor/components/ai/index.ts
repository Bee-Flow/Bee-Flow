/**
 * "Ask AI" on the build screen: the assistant sheet over the builder stream
 * (the web builder's chat panel, Builder/chat/*), its activity rows and the
 * hook the build screen owns it with.
 */

export { catalogAppLabel, describeLiveRun, describeToolCall, type ActivityRow, type AppLabel } from './activity';
export { AiBuilderSheet, type AiBuilderSheetProps } from './AiBuilderSheet';
export { useAssistant, type Assistant } from './useAssistant';
export { welcomeSuggestions } from './welcome';
