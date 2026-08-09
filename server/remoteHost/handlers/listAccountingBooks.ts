// listAccountingBooks command handler (remote-host).
//
// Returns { books: [{ id, name }] } so the mobile remote can show a book picker
// (e.g. before starting an accounting chat). Runs in-process on the host, so it
// bypasses the HTTP bearer layer and calls the accounting engine's listBooks
// directly. Only id + name travel — the remote doesn't need currency / country /
// fiscalYearEnd / createdAt, and trimming keeps the command-channel payload
// minimal (same "only what the client needs" discipline as listSkills).
//
// Exposed as a factory (createListAccountingBooks) so the mapping is
// unit-testable with listBooks stubbed; the default export wires the real
// engine function.
import { listBooks } from "@mulmoclaude/accounting-plugin/server";
import type { CommandHandler, JsonObject } from "../commandChannel.js";

export interface ListAccountingBooksDeps {
  listBooks: typeof listBooks;
  /** Resolve which project's books a command asks for. MulmoClaude is a
   *  single-workspace host and wires none, so every command resolves the
   *  configured workspace exactly as it always has.
   *
   *  It exists so the handler is written as "resolve a scope from the
   *  params, defaulting to the host's root" rather than calling the
   *  workspace accessor inline: the day a multi-root host (MulmoTerminal)
   *  lets a phone pick a project, the parameter is additive and no
   *  handler changes. Three rules the resolver must keep, because a
   *  phone is a genuinely remote client:
   *    · a project is named by an OPAQUE id the host looks up, never by
   *      a path — a root in a command or an artifact publishes the
   *      user's home directory over the wire;
   *    · the phone must be able to LEARN the list ({ id, label } pairs
   *      from the host), so it never has to construct a scope itself;
   *    · the rendered artifact stays host-built, which is what makes the
   *      first rule hold without trusting the client. */
  resolveWorkspaceRoot?: (params: JsonObject) => string | undefined;
}

export const createListAccountingBooks =
  (deps: ListAccountingBooksDeps): CommandHandler =>
  async (params: JsonObject) => {
    const { books } = await deps.listBooks(deps.resolveWorkspaceRoot?.(params));
    // No `toJsonObject` needed here, unlike the sibling handlers: the `.map`
    // rebuilds each entry as an anonymous object literal, and those DO get
    // TypeScript's implicit index signature. `BookSummary`'s own lack of one
    // never reaches the return type.
    return { books: books.map((book) => ({ id: book.id, name: book.name })) };
  };

export const listAccountingBooks = createListAccountingBooks({ listBooks });
