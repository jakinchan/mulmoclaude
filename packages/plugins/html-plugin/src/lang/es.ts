import type { Messages } from "./messages";

const es: Messages = {
  reload: "Recargar desde el disco",
  saveAsPdf: "Guardar como PDF (abre el diálogo de impresión)",
  pdf: "PDF",
  download: "ZIP",
  downloadZip: "Descargar como zip autónomo (recursos incluidos)",
  downloadError: (error) => `⚠ Error al descargar: ${error}`,
  untitled: "Página HTML",
  editSource: "Editar código HTML",
  cancel: "Cancelar",
  applyChanges: "Aplicar cambios",
  saving: "Guardando...",
  saveError: (error) => `⚠ Error al guardar: ${error}`,
  loadingSource: "Cargando código…",
  sourceError: (error) => `Error al cargar el código: ${error}`,
};

export default es;
