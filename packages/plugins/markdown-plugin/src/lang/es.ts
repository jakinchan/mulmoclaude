import type { Messages } from "./messages";

const es: Messages = {
  loading: "Cargando documento...",
  loadFailed: "⚠ Error al cargar el documento: {error}",
  refreshFailed: "⚠ Error al actualizar el documento: {error} — mostrando el último contenido cargado con éxito.",
  noContent: "No hay contenido Markdown disponible",
  reload: "Recargar desde el disco",
  pdf: "PDF",
  pdfFailedShort: "⚠ Error de PDF",
  editSource: "Editar fuente Markdown",
  livePreview: "Vista previa en vivo",
  autoSave: "Guardado automático",
  saving: "Guardando...",
  applyChanges: "Aplicar cambios",
  cancel: "Cancelar",
  saveFailed: "Error al guardar: {error}",
  saveError: "⚠ Error al guardar: {error}",
  copyLabel: "Copiar",
  copiedLabel: "¡Copiado!",
  taskCountMismatch: "El número de tareas no coincide entre la fuente Markdown y la salida renderizada. Se rechazó el cambio para evitar dañar el archivo.",
  marpSlidesMode: "Diapositivas Marp · {count}",
  marpExportPdf: "Exportar PDF",
  marpRenderFailed: "⚠ Error al renderizar las diapositivas Marp: {error}",
  marpSplitEnter: "Editar la fuente junto a la vista previa",
  marpSplitExit: "Cerrar el editor de la fuente",
  marpSplitEditorLabel: "Fuente",
  mermaidLoadFailed: "⚠ Error al cargar Mermaid: {error}",
  mermaidRenderFailed: "⚠ Error al renderizar Mermaid: {error}",
};

export default es;
