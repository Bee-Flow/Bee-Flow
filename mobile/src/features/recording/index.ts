/**
 * Meeting notes: record or import audio, and read what the pipeline made of it.
 * Global search reads the list through listTranscriptions; the meeting-source
 * screens refresh the library after an import through useRefreshMeetings; the
 * org's meeting-notes settings offer the transcription languages.
 * Import from '@/features/recording', never from its internals.
 */

export { RecordingScreen } from './screens/RecordingScreen';
export { RecordScreen } from './screens/RecordScreen';

export { listTranscriptions } from './api/endpoints';
export { useRefreshMeetings } from './hooks/library';
export { TRANSCRIPTION_LANGUAGES } from './model/capture';
