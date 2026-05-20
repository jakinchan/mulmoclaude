import type { FileOps } from "gui-chat-protocol";
import type { WorklogEntry, CandidateEntry } from "../types";
import { loadAllCommittedEntries, appendCommittedEntries, loadAllCandidates, saveCandidate, deleteCandidate, resolveWorklogEntries } from "../io";

export interface LlmActionInput {
  clientId?: string;
  projectId?: string;
  startTime?: string;
  endTime?: string;
  notes?: string;
  billable?: boolean;
  candidateId?: string;
  worklogId?: string;
  range?: {
    from?: string;
    to?: string;
  };
}

export type LlmActionResult =
  | { kind: "error"; status: number; error: string }
  | {
      kind: "success";
      message: string;
      jsonData: Record<string, unknown>;
      data: Record<string, unknown>;
    };

/**
 * Validates ISO 8601 string.
 */
function isValidDate(dateStr: string): boolean {
  const d = new Date(dateStr);
  return !isNaN(d.getTime());
}

/**
 * Action Handler: create (manual candidate entry)
 */
export async function handleCreate(files: FileOps, input: LlmActionInput): Promise<LlmActionResult> {
  const { clientId, projectId, startTime, endTime, notes, billable } = input;

  if (!clientId) {
    return { kind: "error", status: 400, error: "clientId is required for create action" };
  }
  if (!startTime || !endTime) {
    return { kind: "error", status: 400, error: "startTime and endTime are required for create action" };
  }
  if (!isValidDate(startTime) || !isValidDate(endTime)) {
    return { kind: "error", status: 400, error: "startTime and endTime must be valid ISO 8601 strings" };
  }

  const startMs = new Date(startTime).getTime();
  const endMs = new Date(endTime).getTime();
  if (endMs < startMs) {
    return { kind: "error", status: 400, error: "endTime cannot be before startTime" };
  }

  const duration = Math.floor((endMs - startMs) / 1000); // seconds
  const candidateId = `cand-${globalThis.crypto.randomUUID()}`;

  const candidate: CandidateEntry = {
    id: candidateId,
    clientId,
    projectId: projectId || undefined,
    startTime,
    endTime,
    duration,
    billable: billable !== false, // default true
    notes: notes || "",
    confidence: 1.0,
    evidence: [],
  };

  await saveCandidate(files, candidate);

  const durationHours = (duration / 3600).toFixed(2);
  return {
    kind: "success",
    message: `Drafted candidate worklog entry for ${clientId} (${durationHours} hours). Review and approve it on the board.`,
    jsonData: { candidateId, candidate },
    data: { candidate },
  };
}

/**
 * Action Handler: approve (commits candidate log)
 */
export async function handleApprove(files: FileOps, input: LlmActionInput): Promise<LlmActionResult> {
  const { candidateId } = input;
  if (!candidateId) {
    return { kind: "error", status: 400, error: "candidateId is required for approve action" };
  }

  const candidates = await loadAllCandidates(files);
  const candidate = candidates.find((c) => c.id === candidateId);
  if (!candidate) {
    return { kind: "error", status: 404, error: `Candidate entry ${candidateId} not found` };
  }

  // Promote to committed WorklogEntry
  const committedId = `wl-${new Date().toISOString().substring(0, 10)}-${globalThis.crypto.randomUUID().substring(0, 8)}`;
  const entry: WorklogEntry = {
    id: committedId,
    clientId: candidate.clientId,
    projectId: candidate.projectId,
    startTime: candidate.startTime,
    endTime: candidate.endTime,
    duration: candidate.duration,
    billable: candidate.billable,
    source: "manual",
    evidence: candidate.evidence,
    notes: candidate.notes,
    supersedes: null,
    deleted: false,
  };

  await appendCommittedEntries(files, [entry]);
  await deleteCandidate(files, candidateId);

  const durationHours = (entry.duration / 3600).toFixed(2);
  return {
    kind: "success",
    message: `Approved and committed worklog entry ${committedId} for ${entry.clientId} (${durationHours} hours).`,
    jsonData: { worklogId: committedId, entry },
    data: { entry },
  };
}

/**
 * Action Handler: list (queries active committed logs)
 */
export async function handleList(files: FileOps, input: LlmActionInput): Promise<LlmActionResult> {
  const { clientId, range } = input;
  const rawEntries = await loadAllCommittedEntries(files);
  let entries = resolveWorklogEntries(rawEntries);

  if (clientId) {
    const targetClient = clientId.toLowerCase();
    entries = entries.filter((e) => e.clientId.toLowerCase() === targetClient);
  }

  if (range) {
    if (range.from) {
      const fromLimit = range.from;
      entries = entries.filter((e) => e.startTime >= fromLimit);
    }
    if (range.to) {
      const toLimit = range.to;
      entries = entries.filter((e) => e.startTime <= toLimit);
    }
  }

  const totalDuration = entries.reduce((acc, e) => acc + e.duration, 0);
  const totalHours = (totalDuration / 3600).toFixed(2);

  return {
    kind: "success",
    message: `Listed ${entries.length} active committed worklog entries (total: ${totalHours} hours).`,
    jsonData: { entries, totalHours },
    data: { entries },
  };
}

/**
 * Action Handler: edit (appends a superseding committed log entry)
 */
export async function handleEdit(files: FileOps, input: LlmActionInput): Promise<LlmActionResult> {
  const { worklogId, clientId, projectId, startTime, endTime, notes, billable } = input;

  if (!worklogId) {
    return { kind: "error", status: 400, error: "worklogId is required for edit action" };
  }

  const rawEntries = await loadAllCommittedEntries(files);
  const activeEntries = resolveWorklogEntries(rawEntries);
  const oldEntry = activeEntries.find((e) => e.id === worklogId);

  if (!oldEntry) {
    return { kind: "error", status: 404, error: `Active committed worklog entry ${worklogId} not found` };
  }

  const finalStartTime = startTime ?? oldEntry.startTime;
  const finalEndTime = endTime ?? oldEntry.endTime;

  if (!isValidDate(finalStartTime) || !isValidDate(finalEndTime)) {
    return { kind: "error", status: 400, error: "startTime and endTime must be valid ISO 8601 strings" };
  }

  const startMs = new Date(finalStartTime).getTime();
  const endMs = new Date(finalEndTime).getTime();
  if (endMs < startMs) {
    return { kind: "error", status: 400, error: "endTime cannot be before startTime" };
  }

  const duration = Math.floor((endMs - startMs) / 1000);
  const nextId = `wl-${new Date().toISOString().substring(0, 10)}-${globalThis.crypto.randomUUID().substring(0, 8)}`;

  const newEntry: WorklogEntry = {
    id: nextId,
    clientId: clientId ?? oldEntry.clientId,
    projectId: projectId !== undefined ? projectId || undefined : oldEntry.projectId,
    startTime: finalStartTime,
    endTime: finalEndTime,
    duration,
    billable: billable !== undefined ? billable : oldEntry.billable,
    source: "manual",
    evidence: oldEntry.evidence,
    notes: notes !== undefined ? notes : oldEntry.notes,
    supersedes: oldEntry.id,
    deleted: false,
  };

  await appendCommittedEntries(files, [newEntry]);

  return {
    kind: "success",
    message: `Edited worklog entry ${worklogId} (appended new version ${nextId}).`,
    jsonData: { worklogId: nextId, entry: newEntry },
    data: { entry: newEntry },
  };
}

/**
 * Action Handler: delete (appends a superseding tombstone record)
 */
export async function handleDelete(files: FileOps, input: LlmActionInput): Promise<LlmActionResult> {
  const { worklogId } = input;
  if (!worklogId) {
    return { kind: "error", status: 400, error: "worklogId is required for delete action" };
  }

  const rawEntries = await loadAllCommittedEntries(files);
  const activeEntries = resolveWorklogEntries(rawEntries);
  const oldEntry = activeEntries.find((e) => e.id === worklogId);

  if (!oldEntry) {
    return { kind: "error", status: 404, error: `Active committed worklog entry ${worklogId} not found` };
  }

  const nextId = `wl-${new Date().toISOString().substring(0, 10)}-${globalThis.crypto.randomUUID().substring(0, 8)}`;

  const newEntry: WorklogEntry = {
    ...oldEntry,
    id: nextId,
    supersedes: oldEntry.id,
    deleted: true,
  };

  await appendCommittedEntries(files, [newEntry]);

  return {
    kind: "success",
    message: `Deleted worklog entry ${worklogId} (appended tombstone ${nextId}).`,
    jsonData: { worklogId: nextId, deleted: true },
    data: {},
  };
}
