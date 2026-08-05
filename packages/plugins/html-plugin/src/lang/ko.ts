import type { Messages } from "./messages";

const ko: Messages = {
  reload: "디스크에서 다시 불러오기",
  saveAsPdf: "PDF 로 저장 (인쇄 대화 상자 열기)",
  pdf: "PDF",
  download: "ZIP",
  downloadZip: "자체 포함 zip으로 다운로드(에셋 포함)",
  downloadError: (error) => `⚠ 다운로드 실패: ${error}`,
  untitled: "HTML 페이지",
  editSource: "HTML 소스 편집",
  cancel: "취소",
  applyChanges: "변경 사항 적용",
  saving: "저장 중...",
  saveError: (error) => `⚠ 저장 실패: ${error}`,
  loadingSource: "소스를 불러오는 중…",
  sourceError: (error) => `소스 로드 실패: ${error}`,
};

export default ko;
