// Debug beat indicator — toggles the app title color when the server
// emits debug-beat events via pub/sub. Only active in --debug mode.

import { ref, computed, type CSSProperties } from "vue";
import { usePubSub } from "./usePubSub";
import { PUBSUB_CHANNELS } from "../config/pubsubChannels";
import { isRecord } from "../utils/types";

export function useDebugBeat() {
  const debugBeatColor = ref<string | null>(null);
  const debugTitleStyle = computed<CSSProperties>(() => (debugBeatColor.value ? { color: debugBeatColor.value } : {}));

  const { subscribe } = usePubSub();
  subscribe(PUBSUB_CHANNELS.debugBeat, (data) => {
    if (!isRecord(data)) return;
    if (data.last === true) {
      debugBeatColor.value = null;
      return;
    }
    if (typeof data.count !== "number") return;
    debugBeatColor.value = data.count % 2 === 0 ? "#3b82f6" : "#ef4444";
  });

  return { debugTitleStyle };
}
