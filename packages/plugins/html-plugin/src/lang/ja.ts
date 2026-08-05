import type { Messages } from "./messages";

const ja: Messages = {
  reload: "ファイルを再読み込み",
  saveAsPdf: "PDF として保存（印刷ダイアログを開きます）",
  pdf: "PDF",
  download: "ZIP",
  downloadZip: "自己完結zipでダウンロード（アセット同梱）",
  downloadError: (error) => `⚠ ダウンロード失敗: ${error}`,
  untitled: "HTML ページ",
  editSource: "HTML ソースを編集",
  cancel: "キャンセル",
  applyChanges: "変更を適用",
  saving: "保存中...",
  saveError: (error) => `⚠ 保存に失敗しました: ${error}`,
  loadingSource: "ソースを読み込み中…",
  sourceError: (error) => `ソースの読み込みに失敗しました: ${error}`,
};

export default ja;
