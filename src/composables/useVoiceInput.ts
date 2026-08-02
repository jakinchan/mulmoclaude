// Thin Vue wrapper over the framework-neutral capture controller in
// `@mulmoclaude/core/whisper/client` (shared with MulmoTerminal). This file supplies
// the MulmoClaude-specific transport (api client + route constants) and language
// mapping, and mirrors the controller's pushed state into Vue refs. The capture
// logic itself (MediaRecorder + VAD + segment queue) lives in the package.
// See plans/done/feat-extract-whisper-package.md.

import { onScopeDispose, ref, type Ref } from "vue";
import { createVoiceCapture, localeToWhisperLanguage, type VoiceCaptureTransport } from "@mulmoclaude/core/whisper/client";
import { API_ROUTES } from "../config/apiRoutes";
import { apiGet, apiPost } from "../utils/api";
import { deriveVoiceModelReadiness } from "./useVoiceInput.helpers";

export interface VoiceModelStatus {
  name: string;
  state: "idle" | "downloading" | "ready" | "error";
  progress?: number;
  error?: string;
}

/** Response shape of `GET /api/transcribe/model` — host contract consumed by the
 *  Settings → Voice tab. */
export interface VoiceInputStatusResponse {
  capable: boolean;
  enabled: boolean;
  model: VoiceModelStatus;
}

export { localeToWhisperLanguage };

export interface UseVoiceInputOptions {
  /** Current vue-i18n locale (for default transcription language). */
  locale: () => string;
  /** Called with each segment's transcript once recognized (never empty). */
  onTranscript: (text: string) => void;
  /** Called when a segment produced no speech. */
  onEmpty?: (() => void) | undefined;
}

export interface UseVoiceInput {
  available: Ref<boolean>;
  listening: Ref<boolean>;
  transcribing: Ref<boolean>;
  error: Ref<string | null>;
  refreshAvailability: () => Promise<void>;
  start: () => Promise<boolean>;
  stop: () => void;
}

export function useVoiceInput(opts: UseVoiceInputOptions): UseVoiceInput {
  const available = ref(false);
  const listening = ref(false);
  const transcribing = ref(false);
  const error = ref<string | null>(null);

  const transport: VoiceCaptureTransport = {
    async transcribe(dataUrl, language) {
      const result = await apiPost<{ text: string }>(API_ROUTES.transcribe.run, { dataUrl, language });
      if (!result.ok) throw new Error(result.error || "transcription failed");
      return result.data;
    },
    async getStatus() {
      const result = await apiGet<VoiceInputStatusResponse>(API_ROUTES.transcribe.model);
      if (!result.ok) throw new Error(result.error || "status failed");
      return deriveVoiceModelReadiness(result.data);
    },
  };

  const capture = createVoiceCapture(transport, () => localeToWhisperLanguage(opts.locale()), {
    onTranscript: (text) => {
      // A successful segment clears any prior transient error.
      error.value = null;
      opts.onTranscript(text);
    },
    onEmpty: opts.onEmpty,
    onError: (message) => {
      error.value = message;
    },
    onState: (state) => {
      available.value = state.available;
      listening.value = state.listening;
      transcribing.value = state.transcribing;
    },
  });

  // Reset the error at the start of each attempt (restores the pre-extraction
  // behavior) so a stale "permission-denied"/transport error doesn't persist
  // after a later successful start.
  async function start(): Promise<boolean> {
    error.value = null;
    return capture.start();
  }

  onScopeDispose(() => capture.dispose());

  return {
    available,
    listening,
    transcribing,
    error,
    refreshAvailability: capture.refreshAvailability,
    start,
    stop: capture.stop,
  };
}
