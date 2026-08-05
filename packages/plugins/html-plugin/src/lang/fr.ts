import type { Messages } from "./messages";

const fr: Messages = {
  reload: "Recharger depuis le disque",
  saveAsPdf: "Enregistrer en PDF (ouvre la boîte de dialogue d'impression)",
  pdf: "PDF",
  download: "ZIP",
  downloadZip: "Télécharger en zip autonome (ressources incluses)",
  downloadError: (error) => `⚠ Échec du téléchargement : ${error}`,
  untitled: "Page HTML",
  editSource: "Modifier la source HTML",
  cancel: "Annuler",
  applyChanges: "Appliquer les modifications",
  saving: "Enregistrement...",
  saveError: (error) => `⚠ Échec de l'enregistrement : ${error}`,
  loadingSource: "Chargement de la source…",
  sourceError: (error) => `Échec du chargement de la source : ${error}`,
};

export default fr;
