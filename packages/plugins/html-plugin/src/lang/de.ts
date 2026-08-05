import type { Messages } from "./messages";

const de: Messages = {
  reload: "Von der Festplatte neu laden",
  saveAsPdf: "Als PDF speichern (öffnet Druckdialog)",
  pdf: "PDF",
  download: "ZIP",
  downloadZip: "Als eigenständiges ZIP herunterladen (Assets gebündelt)",
  downloadError: (error) => `⚠ Download fehlgeschlagen: ${error}`,
  untitled: "HTML-Seite",
  editSource: "HTML-Quelltext bearbeiten",
  cancel: "Abbrechen",
  applyChanges: "Änderungen anwenden",
  saving: "Wird gespeichert...",
  saveError: (error) => `⚠ Speichern fehlgeschlagen: ${error}`,
  loadingSource: "Quelltext wird geladen…",
  sourceError: (error) => `Quelltext konnte nicht geladen werden: ${error}`,
};

export default de;
