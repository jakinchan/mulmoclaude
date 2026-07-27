// Every user-facing string the icon launcher can show, in the same 8
// locales as the app UI (see docs/i18n.md).
//
// This is a second, standalone catalog rather than a reuse of
// `src/lang/*` on purpose: the launcher runs BEFORE the server exists,
// in plain Node with no vue-i18n, and it must be able to say "Node.js
// is missing" on a machine where nothing else works. Keep it small —
// it only covers what can be said before the app is reachable.
//
// Every failure carries three parts: `title` (what the user sees first),
// `body` (what happened) and `action` (what to do next). A message with
// no `action` is a dead end for someone who does not use a terminal, so
// the shape enforces it.

export const LAUNCHER_LOCALES = ["en", "ja", "zh", "ko", "es", "pt-BR", "fr", "de"];

const DEFAULT_LOCALE = "en";

const enMessages = {
  starting: {
    title: "Starting MulmoClaude",
    detail: "This page switches over on its own once it is ready.",
    firstRun: "Fetching the latest version. The first launch after an update can take up to a minute.",
  },
  nodeMissing: {
    title: "Node.js was not found",
    body: "MulmoClaude runs on Node.js, and it is either not installed or not visible to apps launched from the Finder.",
    action: "Install the LTS version from https://nodejs.org/ and click the icon again.",
    hint: "If you already have Node.js, you can start MulmoClaude from a terminal with: npx mulmoclaude@latest",
  },
  nodeTooOld: {
    title: "This version of Node.js is too old",
    body: "MulmoClaude needs Node.js {required} or newer. The version found was {found}.",
    action: "Update to the current LTS release from https://nodejs.org/ and click the icon again.",
  },
  npxMissing: {
    title: "npm was not found",
    body: "MulmoClaude starts through npx, which comes with npm. Node.js was found, but npm was not.",
    action: "Reinstall Node.js from https://nodejs.org/ — its installer includes npm — then click the icon again.",
  },
  claudeMissing: {
    title: "Claude Code was not found",
    body: "MulmoClaude works through Claude Code, which has to be installed and signed in first.",
    action: "Open Terminal and run these two commands in order:",
    steps: ["npm install -g @anthropic-ai/claude-code", "claude"],
    stepsNote: "The second command asks you to sign in. Once it finishes, click the icon again.",
  },
  startFailed: {
    title: "MulmoClaude could not start",
    body: "Startup began but there was no response after {seconds} seconds.",
    action: "Check your network connection and click the icon again. If it keeps happening, open the log below.",
  },
  noPort: {
    title: "No free port was available",
    body: "MulmoClaude could not find an open port starting from {port}.",
    action: "Quit other apps that may be using these ports, then click the icon again.",
  },
  log: { label: "Log", reveal: "Show log" },
  retry: "Try again",
};

const jaMessages = {
  starting: {
    title: "MulmoClaude を起動しています",
    detail: "準備ができ次第、この画面が自動で切り替わります。",
    firstRun: "最新版を取得しています。更新直後の初回起動は 1 分ほどかかることがあります。",
  },
  nodeMissing: {
    title: "Node.js が見つかりませんでした",
    body: "MulmoClaude は Node.js 上で動きます。インストールされていないか、アイコンから起動したアプリからは見えない場所にあります。",
    action: "https://nodejs.org/ から LTS 版をインストールして、もう一度アイコンをクリックしてください。",
    hint: "すでに Node.js がある場合は、ターミナルで npx mulmoclaude@latest を実行しても起動できます。",
  },
  nodeTooOld: {
    title: "Node.js のバージョンが古すぎます",
    body: "MulmoClaude には Node.js {required} 以降が必要です。見つかったのは {found} でした。",
    action: "https://nodejs.org/ から最新の LTS 版に更新して、もう一度アイコンをクリックしてください。",
  },
  npxMissing: {
    title: "npm が見つかりませんでした",
    body: "MulmoClaude は npx を使って起動します。Node.js は見つかりましたが、npm が見つかりませんでした。",
    action: "https://nodejs.org/ から Node.js を入れ直すと npm も一緒に入ります。その後、もう一度アイコンをクリックしてください。",
  },
  claudeMissing: {
    title: "Claude Code が見つかりませんでした",
    body: "MulmoClaude は Claude Code を通して動きます。先にインストールとログインが必要です。",
    action: "ターミナルを開いて、次の 2 つを順番に実行してください:",
    steps: ["npm install -g @anthropic-ai/claude-code", "claude"],
    stepsNote: "2 つ目でログインを求められます。完了したら、もう一度アイコンをクリックしてください。",
  },
  startFailed: {
    title: "MulmoClaude を起動できませんでした",
    body: "起動処理は始まりましたが、{seconds} 秒待っても応答がありませんでした。",
    action: "ネットワーク接続を確認して、もう一度アイコンをクリックしてください。続くようなら下のログを見てください。",
  },
  noPort: {
    title: "空いているポートがありませんでした",
    body: "{port} 番から順に探しましたが、使えるポートが見つかりませんでした。",
    action: "そのポートを使っている可能性のあるアプリを終了してから、もう一度アイコンをクリックしてください。",
  },
  log: { label: "ログ", reveal: "ログを表示" },
  retry: "もう一度試す",
};

const zhMessages = {
  starting: {
    title: "正在启动 MulmoClaude",
    detail: "准备就绪后，本页面会自动跳转。",
    firstRun: "正在获取最新版本。更新后的首次启动可能需要一分钟左右。",
  },
  nodeMissing: {
    title: "未找到 Node.js",
    body: "MulmoClaude 依赖 Node.js 运行。它可能尚未安装，或者从访达启动的应用无法访问到它。",
    action: "请从 https://nodejs.org/ 安装 LTS 版本，然后再次点击图标。",
    hint: "如果已经安装了 Node.js，也可以在终端中运行 npx mulmoclaude@latest 来启动。",
  },
  nodeTooOld: {
    title: "Node.js 版本过旧",
    body: "MulmoClaude 需要 Node.js {required} 或更高版本，但找到的是 {found}。",
    action: "请从 https://nodejs.org/ 更新到最新的 LTS 版本，然后再次点击图标。",
  },
  npxMissing: {
    title: "未找到 npm",
    body: "MulmoClaude 通过 npx 启动，而 npx 随 npm 一起提供。已找到 Node.js，但没有找到 npm。",
    action: "请从 https://nodejs.org/ 重新安装 Node.js（安装包含 npm），然后再次点击图标。",
  },
  claudeMissing: {
    title: "未找到 Claude Code",
    body: "MulmoClaude 通过 Claude Code 工作，需要先完成安装并登录。",
    action: "请打开终端，依次执行以下两条命令：",
    steps: ["npm install -g @anthropic-ai/claude-code", "claude"],
    stepsNote: "第二条命令会要求你登录。完成后再次点击图标。",
  },
  startFailed: {
    title: "MulmoClaude 启动失败",
    body: "启动过程已开始，但等待 {seconds} 秒后仍无响应。",
    action: "请检查网络连接后再次点击图标。如果反复出现，请查看下方日志。",
  },
  noPort: {
    title: "没有可用端口",
    body: "从 {port} 开始查找，但没有找到可用端口。",
    action: "请退出可能占用这些端口的其他应用，然后再次点击图标。",
  },
  log: { label: "日志", reveal: "查看日志" },
  retry: "重试",
};

const koMessages = {
  starting: {
    title: "MulmoClaude를 시작하는 중입니다",
    detail: "준비가 끝나면 이 화면이 자동으로 전환됩니다.",
    firstRun: "최신 버전을 받는 중입니다. 업데이트 직후 첫 실행은 1분 정도 걸릴 수 있습니다.",
  },
  nodeMissing: {
    title: "Node.js를 찾을 수 없습니다",
    body: "MulmoClaude는 Node.js 위에서 동작합니다. 설치되어 있지 않거나, Finder에서 실행한 앱이 접근할 수 없는 위치에 있습니다.",
    action: "https://nodejs.org/ 에서 LTS 버전을 설치한 뒤 아이콘을 다시 클릭하세요.",
    hint: "이미 Node.js가 있다면 터미널에서 npx mulmoclaude@latest 로도 실행할 수 있습니다.",
  },
  nodeTooOld: {
    title: "Node.js 버전이 너무 낮습니다",
    body: "MulmoClaude에는 Node.js {required} 이상이 필요하지만 {found} 버전이 발견되었습니다.",
    action: "https://nodejs.org/ 에서 최신 LTS 버전으로 업데이트한 뒤 아이콘을 다시 클릭하세요.",
  },
  npxMissing: {
    title: "npm을 찾을 수 없습니다",
    body: "MulmoClaude는 npm에 포함된 npx로 시작합니다. Node.js는 찾았지만 npm은 찾지 못했습니다.",
    action: "https://nodejs.org/ 에서 Node.js를 다시 설치하면 npm도 함께 설치됩니다. 그런 다음 아이콘을 다시 클릭하세요.",
  },
  claudeMissing: {
    title: "Claude Code를 찾을 수 없습니다",
    body: "MulmoClaude는 Claude Code를 통해 동작하므로 먼저 설치하고 로그인해야 합니다.",
    action: "터미널을 열고 다음 두 명령을 순서대로 실행하세요:",
    steps: ["npm install -g @anthropic-ai/claude-code", "claude"],
    stepsNote: "두 번째 명령에서 로그인을 요청합니다. 완료한 뒤 아이콘을 다시 클릭하세요.",
  },
  startFailed: {
    title: "MulmoClaude를 시작하지 못했습니다",
    body: "시작 절차는 진행되었지만 {seconds}초가 지나도 응답이 없었습니다.",
    action: "네트워크 연결을 확인하고 아이콘을 다시 클릭하세요. 계속되면 아래 로그를 확인하세요.",
  },
  noPort: {
    title: "사용할 수 있는 포트가 없습니다",
    body: "{port}번부터 찾아보았지만 사용 가능한 포트를 찾지 못했습니다.",
    action: "해당 포트를 쓰고 있을 만한 앱을 종료한 뒤 아이콘을 다시 클릭하세요.",
  },
  log: { label: "로그", reveal: "로그 보기" },
  retry: "다시 시도",
};

const esMessages = {
  starting: {
    title: "Iniciando MulmoClaude",
    detail: "Esta página cambiará sola en cuanto esté lista.",
    firstRun: "Descargando la última versión. El primer inicio tras una actualización puede tardar hasta un minuto.",
  },
  nodeMissing: {
    title: "No se encontró Node.js",
    body: "MulmoClaude funciona sobre Node.js, y no está instalado o no es visible para las apps abiertas desde el Finder.",
    action: "Instala la versión LTS desde https://nodejs.org/ y vuelve a hacer clic en el icono.",
    hint: "Si ya tienes Node.js, también puedes iniciarlo desde el Terminal con: npx mulmoclaude@latest",
  },
  nodeTooOld: {
    title: "Esta versión de Node.js es demasiado antigua",
    body: "MulmoClaude necesita Node.js {required} o posterior. Se encontró la versión {found}.",
    action: "Actualiza a la versión LTS actual desde https://nodejs.org/ y vuelve a hacer clic en el icono.",
  },
  npxMissing: {
    title: "No se encontró npm",
    body: "MulmoClaude se inicia mediante npx, que viene con npm. Se encontró Node.js, pero no npm.",
    action: "Reinstala Node.js desde https://nodejs.org/ (su instalador incluye npm) y vuelve a hacer clic en el icono.",
  },
  claudeMissing: {
    title: "No se encontró Claude Code",
    body: "MulmoClaude funciona a través de Claude Code, que primero debe instalarse e iniciar sesión.",
    action: "Abre el Terminal y ejecuta estos dos comandos en orden:",
    steps: ["npm install -g @anthropic-ai/claude-code", "claude"],
    stepsNote: "El segundo comando te pedirá iniciar sesión. Cuando termine, vuelve a hacer clic en el icono.",
  },
  startFailed: {
    title: "No se pudo iniciar MulmoClaude",
    body: "El inicio comenzó, pero no hubo respuesta después de {seconds} segundos.",
    action: "Comprueba tu conexión y vuelve a hacer clic en el icono. Si se repite, abre el registro de abajo.",
  },
  noPort: {
    title: "No había ningún puerto libre",
    body: "MulmoClaude no encontró un puerto disponible a partir del {port}.",
    action: "Cierra otras apps que puedan estar usando esos puertos y vuelve a hacer clic en el icono.",
  },
  log: { label: "Registro", reveal: "Ver registro" },
  retry: "Reintentar",
};

const ptBrMessages = {
  starting: {
    title: "Iniciando o MulmoClaude",
    detail: "Esta página muda sozinha assim que estiver pronta.",
    firstRun: "Baixando a versão mais recente. A primeira execução após uma atualização pode levar até um minuto.",
  },
  nodeMissing: {
    title: "O Node.js não foi encontrado",
    body: "O MulmoClaude roda sobre o Node.js, que não está instalado ou não é visível para apps abertos pelo Finder.",
    action: "Instale a versão LTS em https://nodejs.org/ e clique no ícone novamente.",
    hint: "Se você já tem o Node.js, também dá para iniciar pelo Terminal com: npx mulmoclaude@latest",
  },
  nodeTooOld: {
    title: "Esta versão do Node.js é antiga demais",
    body: "O MulmoClaude precisa do Node.js {required} ou mais recente. A versão encontrada foi {found}.",
    action: "Atualize para a versão LTS atual em https://nodejs.org/ e clique no ícone novamente.",
  },
  npxMissing: {
    title: "O npm não foi encontrado",
    body: "O MulmoClaude inicia pelo npx, que vem junto com o npm. O Node.js foi encontrado, mas o npm não.",
    action: "Reinstale o Node.js em https://nodejs.org/ — o instalador inclui o npm — e clique no ícone novamente.",
  },
  claudeMissing: {
    title: "O Claude Code não foi encontrado",
    body: "O MulmoClaude funciona por meio do Claude Code, que precisa ser instalado e ter login feito antes.",
    action: "Abra o Terminal e execute estes dois comandos, nesta ordem:",
    steps: ["npm install -g @anthropic-ai/claude-code", "claude"],
    stepsNote: "O segundo comando pede que você entre na sua conta. Ao terminar, clique no ícone novamente.",
  },
  startFailed: {
    title: "Não foi possível iniciar o MulmoClaude",
    body: "A inicialização começou, mas não houve resposta depois de {seconds} segundos.",
    action: "Verifique sua conexão e clique no ícone novamente. Se persistir, abra o log abaixo.",
  },
  noPort: {
    title: "Nenhuma porta livre disponível",
    body: "O MulmoClaude não encontrou uma porta livre a partir da {port}.",
    action: "Feche outros apps que possam estar usando essas portas e clique no ícone novamente.",
  },
  log: { label: "Log", reveal: "Ver log" },
  retry: "Tentar de novo",
};

const frMessages = {
  starting: {
    title: "Démarrage de MulmoClaude",
    detail: "Cette page basculera d'elle-même dès que tout sera prêt.",
    firstRun: "Récupération de la dernière version. Le premier lancement après une mise à jour peut prendre jusqu'à une minute.",
  },
  nodeMissing: {
    title: "Node.js est introuvable",
    body: "MulmoClaude fonctionne avec Node.js, qui n'est pas installé ou n'est pas visible pour les apps lancées depuis le Finder.",
    action: "Installez la version LTS depuis https://nodejs.org/ puis cliquez à nouveau sur l'icône.",
    hint: "Si Node.js est déjà installé, vous pouvez aussi démarrer depuis le Terminal avec : npx mulmoclaude@latest",
  },
  nodeTooOld: {
    title: "Cette version de Node.js est trop ancienne",
    body: "MulmoClaude nécessite Node.js {required} ou plus récent. La version trouvée est {found}.",
    action: "Mettez à jour vers la version LTS actuelle depuis https://nodejs.org/ puis cliquez à nouveau sur l'icône.",
  },
  npxMissing: {
    title: "npm est introuvable",
    body: "MulmoClaude démarre via npx, fourni avec npm. Node.js a été trouvé, mais pas npm.",
    action: "Réinstallez Node.js depuis https://nodejs.org/ (son installeur inclut npm) puis cliquez à nouveau sur l'icône.",
  },
  claudeMissing: {
    title: "Claude Code est introuvable",
    body: "MulmoClaude passe par Claude Code, qui doit d'abord être installé et connecté.",
    action: "Ouvrez le Terminal et exécutez ces deux commandes dans l'ordre :",
    steps: ["npm install -g @anthropic-ai/claude-code", "claude"],
    stepsNote: "La seconde commande vous demandera de vous connecter. Une fois terminé, cliquez à nouveau sur l'icône.",
  },
  startFailed: {
    title: "MulmoClaude n'a pas pu démarrer",
    body: "Le démarrage a commencé, mais aucune réponse après {seconds} secondes.",
    action: "Vérifiez votre connexion puis cliquez à nouveau sur l'icône. Si cela persiste, ouvrez le journal ci-dessous.",
  },
  noPort: {
    title: "Aucun port disponible",
    body: "MulmoClaude n'a trouvé aucun port libre à partir de {port}.",
    action: "Fermez les autres apps susceptibles d'utiliser ces ports puis cliquez à nouveau sur l'icône.",
  },
  log: { label: "Journal", reveal: "Afficher le journal" },
  retry: "Réessayer",
};

const deMessages = {
  starting: {
    title: "MulmoClaude wird gestartet",
    detail: "Diese Seite wechselt von selbst, sobald alles bereit ist.",
    firstRun: "Die neueste Version wird geladen. Der erste Start nach einem Update kann bis zu einer Minute dauern.",
  },
  nodeMissing: {
    title: "Node.js wurde nicht gefunden",
    body: "MulmoClaude läuft auf Node.js. Es ist entweder nicht installiert oder für aus dem Finder gestartete Apps nicht sichtbar.",
    action: "Installiere die LTS-Version von https://nodejs.org/ und klicke erneut auf das Symbol.",
    hint: "Wenn Node.js bereits vorhanden ist, kannst du auch im Terminal starten: npx mulmoclaude@latest",
  },
  nodeTooOld: {
    title: "Diese Node.js-Version ist zu alt",
    body: "MulmoClaude benötigt Node.js {required} oder neuer. Gefunden wurde {found}.",
    action: "Aktualisiere auf die aktuelle LTS-Version von https://nodejs.org/ und klicke erneut auf das Symbol.",
  },
  npxMissing: {
    title: "npm wurde nicht gefunden",
    body: "MulmoClaude startet über npx, das zu npm gehört. Node.js wurde gefunden, npm jedoch nicht.",
    action: "Installiere Node.js von https://nodejs.org/ neu — der Installer enthält npm — und klicke erneut auf das Symbol.",
  },
  claudeMissing: {
    title: "Claude Code wurde nicht gefunden",
    body: "MulmoClaude arbeitet über Claude Code, das zuerst installiert und angemeldet sein muss.",
    action: "Öffne das Terminal und führe diese beiden Befehle nacheinander aus:",
    steps: ["npm install -g @anthropic-ai/claude-code", "claude"],
    stepsNote: "Der zweite Befehl fordert dich zur Anmeldung auf. Danach klicke erneut auf das Symbol.",
  },
  startFailed: {
    title: "MulmoClaude konnte nicht gestartet werden",
    body: "Der Start hat begonnen, aber nach {seconds} Sekunden kam keine Antwort.",
    action: "Prüfe deine Netzwerkverbindung und klicke erneut auf das Symbol. Bei wiederholtem Auftreten öffne das Protokoll unten.",
  },
  noPort: {
    title: "Kein freier Port verfügbar",
    body: "MulmoClaude hat ab Port {port} keinen freien Port gefunden.",
    action: "Beende andere Apps, die diese Ports belegen könnten, und klicke erneut auf das Symbol.",
  },
  log: { label: "Protokoll", reveal: "Protokoll anzeigen" },
  retry: "Erneut versuchen",
};

const CATALOG = {
  en: enMessages,
  ja: jaMessages,
  zh: zhMessages,
  ko: koMessages,
  es: esMessages,
  "pt-BR": ptBrMessages,
  fr: frMessages,
  de: deMessages,
};

/**
 * Narrow an OS locale string to one this catalog actually has.
 * Accepts what macOS (`ja_JP`, `pt_BR`) and Windows (`ja-JP`, `pt-BR`)
 * report, plus a bare language tag. Unknown input falls back to English
 * rather than throwing — a launcher that dies while picking a language
 * has failed at the one job it has.
 * @param {string | undefined | null} rawLocale
 * @returns {string}
 */
export function pickLauncherLocale(rawLocale) {
  if (typeof rawLocale !== "string" || rawLocale.length === 0) return DEFAULT_LOCALE;
  const normalized = rawLocale.replace("_", "-");
  const exact = LAUNCHER_LOCALES.find((locale) => locale.toLowerCase() === normalized.toLowerCase());
  if (exact) return exact;
  const [language] = normalized.split("-");
  const byLanguage = LAUNCHER_LOCALES.find((locale) => locale.toLowerCase() === language.toLowerCase());
  // Only a regional variant may be shipped, so `pt` and `pt-PT` resolve
  // to `pt-BR` rather than to English — the same last step as the app's
  // `resolveLocale()` in `src/lang/index.ts`.
  const byVariant = LAUNCHER_LOCALES.find((locale) => locale.toLowerCase().startsWith(`${language.toLowerCase()}-`));
  return byLanguage ?? byVariant ?? DEFAULT_LOCALE;
}

/**
 * @param {string} locale
 * @returns {typeof enMessages}
 */
export function launcherMessages(locale) {
  return CATALOG[pickLauncherLocale(locale)];
}

/**
 * Substitute `{name}` placeholders. Values are stringified as-is; an
 * unknown placeholder is left verbatim so a typo shows up in the UI
 * instead of silently rendering "undefined".
 * @param {string} template
 * @param {Record<string, string | number>} values
 * @returns {string}
 */
export function fillPlaceholders(template, values) {
  return template.replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match));
}
