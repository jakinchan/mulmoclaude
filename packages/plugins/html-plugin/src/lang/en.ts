import type { Messages } from "./messages";

const en: Messages = {
  reload: "Reload from disk",
  saveAsPdf: "Save as PDF (opens print dialog)",
  pdf: "PDF",
  download: "ZIP",
  downloadZip: "Download as a self-contained zip (assets bundled)",
  downloadError: (error) => `⚠ Download failed: ${error}`,
  untitled: "HTML Page",
  editSource: "Edit HTML Source",
  cancel: "Cancel",
  applyChanges: "Apply Changes",
  saving: "Saving...",
  saveError: (error) => `⚠ Save failed: ${error}`,
  loadingSource: "Loading source…",
  sourceError: (error) => `Failed to load source: ${error}`,
};

export default en;
