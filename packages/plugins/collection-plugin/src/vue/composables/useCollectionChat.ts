// The collection's chat entry points: the header "chat about this collection"
// modal and the open record's "chat about this record" box. Both build a chat
// seed from the current view — a skill-backed collection seeds its `/<slug>`
// command, a data-only feed points the agent at its schema + records — and
// dispatch it into the current session (embedded chat card) or a new General
// chat (standalone page).
//
// Extracted from CollectionView as a reactive shell; the skill-seed shape lives
// in core (`skillCommandSeed`).

import { ref, type Ref } from "vue";
import { rowIdOf, skillCommandSeed, type CollectionDetail, type CollectionItem } from "@mulmoclaude/core/collection";
import type { CollectionUi } from "../uiContext";
import type { useCollectionI18n } from "../lang";

type Translate = ReturnType<typeof useCollectionI18n>["t"];

interface UseCollectionChatParams {
  collection: Ref<CollectionDetail | null>;
  viewing: Ref<CollectionItem | null>;
  cui: CollectionUi;
  /** The chat card's channel into the current session (embedded mode only). */
  props: { sendTextMessage?: ((text?: string) => void) | undefined };
  t: Translate;
}

export interface UseCollectionChat {
  chatOpen: Ref<boolean>;
  openChat: () => void;
  closeChat: () => void;
  submitChat: (raw: string) => void;
  onItemChat: (message: string) => void;
}

export function useCollectionChat({ collection, viewing, cui, props, t }: UseCollectionChatParams): UseCollectionChat {
  const chatOpen = ref(false);

  /** Open the chat modal. The modal owns its draft + focus: it remounts on every
   *  open (parent `v-if`), so it starts blank and self-focuses. */
  function openChat(): void {
    chatOpen.value = true;
  }

  function closeChat(): void {
    chatOpen.value = false;
  }

  /** Build the chat seed text for the current view. A collection IS a skill, so
   *  its slug doubles as a slash command (`/<slug> <message>`). A feed is
   *  data-only — no skill — so point the agent at the feed's schema + records
   *  instead. Checked via `source` directly (not the `isFeed` computed) to keep
   *  this self-contained. */
  function buildChatSeed(slug: string, message: string, itemId?: string): string {
    const current = collection.value;
    if (current?.source !== "feed") return skillCommandSeed(slug, message, itemId);
    const dataPath = current.schema.dataPath ?? `data/feeds/${slug}`;
    const scoped = itemId ? `(for record \`${itemId}\`) ${message}` : message;
    return t("collectionsView.feedChatSeed", { slug, dataPath, message: scoped });
  }

  /** Dispatch a seed: into the current session when embedded, else a new chat. */
  function dispatchSeed(text: string): void {
    if (props.sendTextMessage) {
      props.sendTextMessage(text);
      return;
    }
    cui.startChat(text, cui.generalRoleId);
  }

  /** Start a chat seeded from the current view. `raw` is the modal's untrimmed
   *  textarea text. */
  function submitChat(raw: string): void {
    if (!collection.value) return;
    const message = raw.trim();
    if (!message) return;
    closeChat();
    dispatchSeed(buildChatSeed(collection.value.slug, message));
  }

  /** The open record's chat box: start a chat scoped to that one record. Seeds
   *  the collection's skill command with an `id=<itemId>` selector so the agent
   *  acts on this record. */
  function onItemChat(message: string): void {
    if (!collection.value || !viewing.value) return;
    const text = message.trim();
    if (!text) return;
    const itemId = rowIdOf(collection.value.schema.primaryKey, viewing.value);
    dispatchSeed(buildChatSeed(collection.value.slug, text, itemId || undefined));
  }

  return { chatOpen, openChat, closeChat, submitChat, onItemChat };
}
