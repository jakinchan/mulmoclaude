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
}

export const createListAccountingBooks =
  (deps: ListAccountingBooksDeps): CommandHandler =>
  // Takes no params (the `__` prefix marks it intentionally unused per lint).
  async (__params: JsonObject) => {
    const { books } = await deps.listBooks();
    // No `toJsonObject` needed here, unlike the sibling handlers: the `.map`
    // rebuilds each entry as an anonymous object literal, and those DO get
    // TypeScript's implicit index signature. `BookSummary`'s own lack of one
    // never reaches the return type.
    return { books: books.map((book) => ({ id: book.id, name: book.name })) };
  };

export const listAccountingBooks = createListAccountingBooks({ listBooks });
