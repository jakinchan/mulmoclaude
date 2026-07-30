// Server-only Google engine: local OAuth (loopback + PKCE), token store at
// `~/.config/mulmo/google-token.json`, and REST calls for Calendar, Tasks,
// and Drive (`drive.file` — app-created files only). Shared by the hosts
// (remote-host handlers, /api routes, each host's auth CLI) and the google
// plugin — the token file has a single owner, so every surface sees the same
// link state.
export { configureGoogleHost, type GoogleLogger } from "./host.js";
export { isIsoDateTimeWithOffset } from "./datetime.js";
export { googleConfigDir, googleSecretsDir, googleTokenPath, legacyGoogleTokenPath } from "./paths.js";
export { clientSecretPresence, findClientSecretPath, loadClientSecret, type ClientSecretPresence, type InstalledClientSecret } from "./clientSecret.js";
export { deleteGoogleTokens, loadGoogleTokens, mergeGoogleTokens, saveGoogleTokens, type IssuedVia, type StoredGoogleTokens } from "./tokenStore.js";
export { brokerBaseUrl, brokerExchange, brokerRefresh, brokerStart, type BrokerStartResponse } from "./broker.js";
export {
  authorizeGoogle,
  commitLinkedTokens,
  getGoogleAccessToken,
  unlinkGoogle,
  waitForAuthCode,
  GOOGLE_AUTH_CANCELLED,
  GOOGLE_CALENDAR_SCOPE,
  GOOGLE_CALENDARLIST_SCOPE,
  GOOGLE_TASKS_SCOPE,
  GOOGLE_DRIVE_FILE_SCOPE,
  GOOGLE_SCOPES,
  type AuthorizeGoogleOptions,
  type RevokeFetch,
} from "./auth.js";
export { createGoogleAuthFlow, googleAuthFlow, type GoogleAuthFlow, type GoogleAuthFlowStatus } from "./authFlow.js";
export { googleApiError, isGoogleApiError, GoogleApiError, DEFAULT_LIST_MAX_RESULTS, HTTP_FORBIDDEN, MAX_LIST_RESULTS } from "./apiClient.js";
export {
  buildEventPatch,
  calendarApiError,
  collectCalendarPages,
  createCalendarEvent,
  deleteCalendarEvent,
  getCalendarColors,
  canonicalCalendarId,
  listCalendarEvents,
  listCalendars,
  syncCalendarEvents,
  toCalendarSummary,
  toEventSummary,
  updateCalendarEvent,
  getCalendar,
  getCalendarEvent,
  resolveEventSpan,
  CANCELLED_EVENT_STATUS,
  HTTP_CONFLICT,
  HTTP_PRECONDITION_FAILED,
  type CalendarColorEntry,
  type CalendarColors,
  type CalendarEventInput,
  type CalendarEventSpan,
  type CalendarEventSummary,
  type CalendarEventTime,
  type CalendarListPage,
  type CalendarSummary,
  type CalendarSyncResult,
  type DeleteCalendarEventInput,
  type FetchedCalendarEvent,
  type ListEventsInput,
  type SyncEventsInput,
  type UpdateCalendarEventInput,
} from "./calendar.js";
export { calendarSyncStatePath, clearCalendarSyncToken, loadCalendarSyncToken, saveCalendarSyncToken } from "./calendarSyncStore.js";
export {
  calendarPushStatePath,
  clearCalendarShadow,
  loadCalendarShadow,
  mergeShadow,
  saveCalendarShadow,
  toShadowEvent,
  type ShadowEvent,
} from "./calendarPushState.js";
export {
  isDeniedAccessRole,
  isUnpushed,
  pushCalendarForCollection,
  pushCollectionNow,
  type PushOutcomeKind,
  type CalendarCollectionPushResult,
  type CalendarPushDeps,
  type CalendarPushOutcome,
  type CalendarWriteTarget,
} from "./collectionPush.js";
export { toGoogleEventTime, zoneSuffixOf } from "./pushDateTime.js";
export {
  baselineRecord,
  bySourceField,
  conflictingFields,
  fieldText,
  isClientSettableEventId,
  locallyChangedFields,
  locallyDeletedIds,
  mayAdoptExisting,
  planRecord,
  pushableMap,
  PUSHABLE_SOURCE_FIELDS,
  type PushableSourceField,
  type RecordPlan,
} from "./pushPlan.js";
export { toCollectionDateTime } from "./collectionDateTime.js";
export { withCalendarLock, withKeyedLock } from "./calendarLock.js";
export { mergeIntoExisting, toCollectionRecord, type GoogleCalendarSourceField } from "./collectionProjection.js";
export {
  googleCalendarSyncTaskDef,
  classifyDelete,
  classifyWrite,
  anySyncedCollectionSurvives,
  groupByCalendar,
  allUnpushed,
  orphanedCalendarId,
  pullableEvents,
  releaseOrphanedCalendarToken,
  unpushedFor,
  type UnpushedBySlug,
  syncCalendarForCollection,
  syncCalendarGroup,
  syncDueCalendarCollections,
  syncNewCalendarCollections,
  shadowUpdates,
  unsyncedGroups,
  GOOGLE_CALENDAR_SYNC_TASK_ID,
  type CalendarCollectionSyncResult,
  type CalendarDeclaring,
  type ManualCalendarSyncDeps,
  type ManualCalendarSyncOutcome,
} from "./collectionSync.js";
export {
  buildTaskPatch,
  canonicalTaskListId,
  completeTask,
  createTask,
  deleteTask,
  listTaskLists,
  listTasks,
  toTaskListSummary,
  toTaskSummary,
  uncompleteTask,
  updateTask,
  type CompleteTaskInput,
  type CreateTaskInput,
  type ListTasksInput,
  type TaskListSummary,
  type TaskSummary,
  type UpdateTaskInput,
} from "./tasks.js";
export {
  assertSafeMimeType,
  buildMultipartBody,
  createDriveFile,
  deleteDriveFile,
  isTextMimeType,
  listDriveFiles,
  pickBoundary,
  readDriveFile,
  toDriveFileSummary,
  type CreateDriveFileInput,
  type DriveFileSummary,
  type ListDriveFilesInput,
  type ReadDriveFileInput,
} from "./driveFile.js";
