import type { Messages } from "./messages";

const zh: Messages = {
  reload: "从磁盘重新加载",
  saveAsPdf: "另存为 PDF(打开打印对话框)",
  pdf: "PDF",
  download: "ZIP",
  downloadZip: "下载为自包含 zip(含资源)",
  downloadError: (error) => `⚠ 下载失败：${error}`,
  untitled: "HTML 页面",
  editSource: "编辑 HTML 源代码",
  cancel: "取消",
  applyChanges: "应用更改",
  saving: "保存中...",
  saveError: (error) => `⚠ 保存失败：${error}`,
  loadingSource: "正在加载源代码…",
  sourceError: (error) => `加载源代码失败：${error}`,
};

export default zh;
