/* Hermes Pilot — standard-dashboard tab.
 *
 * Plain IIFE, no bundler and no JSX: the host exposes React plus an
 * authenticated fetch on window.__HERMES_PLUGIN_SDK__, and this file registers
 * one component. Every number shown comes from /api/plugins/hermes-pilot/* —
 * this file only formats it and owns the two-tap confirm on restart.
 *
 * Nothing here ever sees the app token: the backend keeps it server-side and
 * returns a one-time pairing code as a PNG instead (see pilot_dashboard.py).
 *
 * Styling lives in style.css under the `hp-` prefix and reads the host's
 * --color-* tokens, so the tab follows whichever theme is active.
 */
(function () {
  "use strict";

  var SDK = window.__HERMES_PLUGIN_SDK__;
  if (!SDK || !SDK.React || !SDK.hooks) {
    console.error("[hermes-pilot] dashboard plugin SDK missing; tab not registered");
    return;
  }
  if (!window.__HERMES_PLUGINS__ || !window.__HERMES_PLUGINS__.register) {
    console.error("[hermes-pilot] plugin registry missing; tab not registered");
    return;
  }

  var React = SDK.React;
  var h = React.createElement;
  var useState = SDK.hooks.useState;
  var useEffect = SDK.hooks.useEffect;
  var useCallback = SDK.hooks.useCallback;
  var useRef = SDK.hooks.useRef || React.useRef;

  var API = "/api/plugins/hermes-pilot";
  /** The QR is rendered at 1:1 so a phone camera sees square modules. */
  var QR_SIZE = 287;

  // ------------------------------------------------------------------ strings

  var STRINGS = {
    en: {
      title: "Hermes Pilot",
      lead: "Pair a phone or tablet with the Hermes Pilot PWA, and keep the bridge running.",
      refresh: "Refresh",
      loading: "Loading…",
      failed: "Could not load",
      service: "Service",
      port: "Port",
      bridge: "Bridge",
      version: "Version",
      running: "running",
      stopped: "stopped",
      unknownState: "unknown",
      reachable: "reachable",
      unreachable: "unreachable",
      noManager: "no service manager",
      pairingTitle: "Pairing",
      pairingLead: "Scan this with the phone camera. The code is single-use and expires.",
      pairingMissing: "The bridge is not running, so no pairing code can be issued.",
      newCode: "New code",
      expiresIn: "expires in {n} min",
      expired: "expired — press New code",
      copy: "Copy",
      copied: "Copied",
      steps: [
        "Turn Tailscale on (or join the same Wi-Fi)",
        "Scan the QR with the camera",
        "It opens signed in — start using it"
      ],
      settingsTitle: "Settings",
      settingsLead: "Where the PWA looks for repositories, and how it is reached.",
      scanDirs: "Scan directories",
      scanDirsHint: "One per line. Existing directories only; ~ is expanded.",
      tlsPort: "TLS port",
      tlsPortHint: "Optional — the HTTPS port Tailscale serve publishes.",
      tailscaleDns: "Tailscale DNS name",
      tailscaleDnsHint: "Optional — e.g. machine.tailnet-name.ts.net",
      servicePort: "Bridge port",
      save: "Save",
      saving: "Saving…",
      saved: "Saved",
      serviceTitle: "Service",
      serviceLead: "The bridge runs under launchd (macOS) or systemd --user (Linux).",
      check: "Check status",
      install: "Install service",
      restart: "Restart bridge",
      restartArmed: "Tap again to restart",
      output: "Output",
      linksTitle: "Open the PWA",
      lan: "LAN",
      tailscale: "Tailscale",
      noLink: "Not detected yet",
      reposTitle: "Repositories",
      reposLead: "The working directories the PWA can open. Add, hide, pin — or give one a board.",
      repoAdd: "Add",
      repoAddPlaceholder: "~/Projects/repo or /absolute/path",
      pin: "Pin",
      unpin: "Unpin",
      hide: "Hide",
      unhide: "Unhide",
      boardCreate: "Create board",
      hiddenTitle: "Hidden",
      hiddenNone: "Nothing is hidden.",
      repoEmpty: "No repositories detected yet. Add one by path.",
      repoScanDirsLabel: "Scan directories",
      repoScanDirsHint: "Edit them in Settings — saving there updates config.json and repos.json together.",
      repoFromFile: "Bridge offline — this list comes from repos.json.",
      reposSaved: "Saved",
      boardReady: "Board ready",
      snippetsTitle: "Snippets",
      snippetsLead: "The chat and terminal shortcuts. Hot pins one to the PWA's quick bar.",
      tabChat: "Chat",
      tabTerm: "Terminal",
      hot: "Hot",
      hiddenTag: "Hidden",
      customTag: "custom",
      remove: "Remove",
      snippetNew: "Add snippet",
      snippetLabel: "Label",
      snippetText: "Text",
      snippetRun: "Executes a command",
      saveSnippets: "Save snippets",
      resetSnippets: "Reset",
      resetArmed: "Tap again to reset",
      snippetsFileOnly: "Bridge offline — only the saved custom entries can be edited.",
      logsTitle: "Logs & audit",
      logsLead: "Tail of the gateway, error, bridge and audit logs. Tokens are redacted before they reach this page.",
      logGateway: "Gateway",
      logErrors: "Errors",
      logPilot: "Bridge",
      logAudit: "Audit",
      logEmpty: "No entries yet.",
      logMissing: "This log file does not exist yet.",
      langLabel: "Language",
      langHint: "Auto follows the browser. EN / 日本語 is saved to config.json.",
      langAuto: "Auto",
      navLabel: "Jump to a section",
      auditList: "List",
      auditRaw: "Raw",
      auditShowMore: "▼ Show {n} more",
      auditCollapse: "▲ Collapse",
      auditEmpty: "No audit entries yet.",
      err: {
        not_a_directory: "Not an existing directory",
        home_directory: "Pick the folders under your home directory",
        empty: "Add at least one directory",
        too_many: "Too many directories",
        invalid_list: "Expected a list of directories",
        out_of_range: "Must be between 1 and 65535",
        not_a_number: "Must be a number",
        required: "Required",
        invalid_hostname: "Not a valid hostname",
        invalid_lang: "Unsupported language"
      }
    },
    ja: {
      title: "Hermes Pilot",
      lead: "スマホ・タブレットを PWA とペアリングし、ブリッジを常駐させます。",
      refresh: "更新",
      loading: "読み込み中…",
      failed: "読み込めませんでした",
      service: "サービス",
      port: "ポート",
      bridge: "ブリッジ",
      version: "バージョン",
      running: "稼働中",
      stopped: "停止",
      unknownState: "不明",
      reachable: "到達可",
      unreachable: "到達不可",
      noManager: "サービス管理なし",
      pairingTitle: "ペアリング",
      pairingLead: "スマホのカメラで読み取ってください。コードは 1 回限り・有効期限あり。",
      pairingMissing: "ブリッジが動いていないため、ペアリングコードを発行できません。",
      newCode: "コードを再発行",
      expiresIn: "残り {n} 分",
      expired: "期限切れ — コードを再発行してください",
      copy: "コピー",
      copied: "コピーしました",
      steps: [
        "Tailscale をオンにする（または同じ Wi-Fi に接続）",
        "QR をカメラで読み取る",
        "そのままログイン済みで開きます"
      ],
      settingsTitle: "設定",
      settingsLead: "PWA がリポジトリを探す場所と、接続方法。",
      scanDirs: "スキャン対象ディレクトリ",
      scanDirsHint: "1 行に 1 つ。実在するディレクトリのみ。~ は展開されます。",
      tlsPort: "TLS ポート",
      tlsPortHint: "任意 — Tailscale serve が公開する HTTPS ポート。",
      tailscaleDns: "Tailscale DNS 名",
      tailscaleDnsHint: "任意 — 例: machine.tailnet-name.ts.net",
      servicePort: "ブリッジのポート",
      save: "保存",
      saving: "保存中…",
      saved: "保存しました",
      serviceTitle: "サービス",
      serviceLead: "ブリッジは launchd（macOS）/ systemd --user（Linux）で常駐します。",
      check: "状態を確認",
      install: "サービスを登録",
      restart: "ブリッジを再起動",
      restartArmed: "もう一度タップで再起動",
      output: "出力",
      linksTitle: "PWA を開く",
      lan: "LAN",
      tailscale: "Tailscale",
      noLink: "未検出",
      reposTitle: "リポジトリ",
      reposLead: "PWA から開ける作業ディレクトリ。追加・非表示・ピン留め・ボード作成。",
      repoAdd: "追加",
      repoAddPlaceholder: "~/Projects/repo か絶対パス",
      pin: "ピン",
      unpin: "外す",
      hide: "非表示",
      unhide: "再表示",
      boardCreate: "ボード作成",
      hiddenTitle: "非表示中",
      hiddenNone: "非表示のリポジトリはありません。",
      repoEmpty: "まだリポジトリが見つかっていません。パスで追加してください。",
      repoScanDirsLabel: "スキャン対象",
      repoScanDirsHint: "編集は「設定」で。保存すると config.json と repos.json の両方が更新されます。",
      repoFromFile: "ブリッジ停止中 — repos.json の内容を表示しています。",
      reposSaved: "保存しました",
      boardReady: "ボードを用意しました",
      snippetsTitle: "スニペット",
      snippetsLead: "チャットと端末の定型文。Hot にすると PWA のクイックバーに出ます。",
      tabChat: "チャット",
      tabTerm: "端末",
      hot: "Hot",
      hiddenTag: "非表示",
      customTag: "カスタム",
      remove: "削除",
      snippetNew: "スニペットを追加",
      snippetLabel: "ラベル",
      snippetText: "本文",
      snippetRun: "コマンドを実行する",
      saveSnippets: "スニペットを保存",
      resetSnippets: "既定に戻す",
      resetArmed: "もう一度タップでリセット",
      snippetsFileOnly: "ブリッジ停止中 — 保存済みのカスタムだけ編集できます。",
      logsTitle: "ログ・監査",
      logsLead: "ゲートウェイ・エラー・ブリッジ・監査ログの末尾。トークンは秘匿してから返します。",
      logGateway: "ゲートウェイ",
      logErrors: "エラー",
      logPilot: "ブリッジ",
      logAudit: "監査",
      logEmpty: "まだ出力がありません。",
      logMissing: "このログファイルはまだありません。",
      langLabel: "言語",
      langHint: "「自動」はブラウザの言語に従います。EN / 日本語 は config.json に保存されます。",
      langAuto: "自動",
      navLabel: "セクションへ移動",
      auditList: "一覧",
      auditRaw: "生ログ",
      auditShowMore: "▼ 他 {n} 件を表示",
      auditCollapse: "▲ 折りたたむ",
      auditEmpty: "監査ログはまだありません。",
      err: {
        not_a_directory: "実在するディレクトリではありません",
        home_directory: "ホーム直下ではなく、その下のフォルダを指定してください",
        empty: "1 つ以上指定してください",
        too_many: "指定が多すぎます",
        invalid_list: "ディレクトリの一覧が必要です",
        out_of_range: "1〜65535 の範囲で指定してください",
        not_a_number: "数値で指定してください",
        required: "必須です",
        invalid_hostname: "ホスト名の形式ではありません",
        invalid_lang: "未対応の言語です"
      }
    }
  };

  /** The tab follows the browser language; English is the fallback (SPEC D5). */
  function detectLang() {
    var list = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || "en"]);
    for (var i = 0; i < list.length; i++) {
      var tag = String(list[i] || "").toLowerCase();
      if (tag.indexOf("ja") === 0) return "ja";
      if (tag.indexOf("en") === 0) return "en";
    }
    return "en";
  }

  // ------------------------------------------------------- language preference

  /** Where the browser remembers an explicit EN/日本語 choice (SPEC V3 §3.5). */
  var LANG_KEY = "hp.dashboard.lang";

  function readStoredLang() {
    try {
      var raw = window.localStorage.getItem(LANG_KEY);
      return raw === "en" || raw === "ja" ? raw : null;
    } catch (e) {
      return null;
    }
  }

  /** `null` forgets the choice, so the tab falls back to config + browser. */
  function writeStoredLang(value) {
    try {
      if (value === "en" || value === "ja") window.localStorage.setItem(LANG_KEY, value);
      else window.localStorage.removeItem(LANG_KEY);
    } catch (e) {
      /* private mode / disabled storage: the tab still works, it just forgets */
    }
  }

  /**
   * Which language to render, in priority order (SPEC V3 §3.5).
   *
   * 1. an explicit choice in this browser (`hp.dashboard.lang`)
   * 2. `config.json`'s `lang` — but only when it says `ja`, because `en` is also
   *    the fresh-install default and would otherwise hide a Japanese browser
   * 3. the browser language, English fallback (SPEC D5) — also what `auto` means
   */
  function pickLang(stored, configLang, browserLang) {
    if (stored === "en" || stored === "ja") return stored;
    if (configLang === "ja") return "ja";
    return browserLang === "ja" ? "ja" : "en";
  }

  function saveLang(next) {
    if (next !== "en" && next !== "ja" && next !== "auto") return Promise.resolve(null);
    // Silent by design: the tab must never show an error because config.json
    // could not be written — the local choice already took effect.
    return request("/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lang: next })
    }).catch(function () {
      return null;
    });
  }

  // ------------------------------------------------------------ audit parsing

  /** How many audit entries stay visible before the accordion (SPEC V3 §3.5). */
  var AUDIT_VISIBLE = 8;

  /** One audit line → `{at, kind, ok, detail}`; junk lines still render. */
  function parseAuditEntry(line) {
    var text = String(line == null ? "" : line);
    var parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      parsed = null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { at: "", kind: "", ok: null, detail: text };
    }
    var detail = [];
    Object.keys(parsed).forEach(function (key) {
      if (key === "at" || key === "kind" || key === "ok") return;
      var value = parsed[key];
      if (value === null || value === undefined || value === "") return;
      detail.push(key + "=" + (typeof value === "object" ? JSON.stringify(value) : String(value)));
    });
    return {
      at: typeof parsed.at === "string" ? parsed.at : "",
      kind: typeof parsed.kind === "string" ? parsed.kind : "",
      ok: typeof parsed.ok === "boolean" ? parsed.ok : null,
      detail: detail.join(" · ")
    };
  }

  /** `2026-11-14T02:08:31.123Z` → `11-14 02:08:31`; anything else passes through. */
  function shortTime(value) {
    var text = String(value || "");
    if (text.length >= 19 && text.charAt(10) === "T") return text.slice(5, 19).replace("T", " ");
    return text;
  }

  /** Newest first: the tail of the file is what the reader wants first. */
  function parseAuditLines(lines) {
    var out = [];
    for (var i = (lines || []).length - 1; i >= 0; i--) out.push(parseAuditEntry(lines[i]));
    return out;
  }

  // ------------------------------------------------------------------ helpers

  /** One JSON request against the plugin backend, auth handled by the host SDK. */
  function request(path, options) {
    return SDK.authedFetch(API + path, options).then(function (res) {
      return res
        .json()
        .catch(function () {
          return {};
        })
        .then(function (body) {
          return { status: res.status, body: body || {} };
        });
    });
  }

  /** Human-readable reason from an error envelope. */
  function reasonOf(res, fallback) {
    if (res && res.body && (res.body.error || res.body.code)) return res.body.error || res.body.code;
    if (res && res.status) return "HTTP " + res.status;
    return fallback;
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return Promise.reject(new Error("clipboard unavailable"));
  }

  function Chip(props) {
    return h(
      "span",
      { className: "hp-chip" + (props.tone ? " hp-chip-" + props.tone : "") },
      h("span", { className: "hp-chip-label" }, props.label),
      h("strong", null, props.value)
    );
  }

  function Card(props) {
    return h(
      "section",
      { className: "hp-card", id: props.id || undefined },
      h(
        "header",
        { className: "hp-card-head" },
        h("h2", null, props.title),
        props.hint ? h("p", { className: "hp-hint" }, props.hint) : null
      ),
      props.children
    );
  }

  /** The section ids the jump chips scroll to (SPEC V3 §3.5). */
  var SECTIONS = [
    { id: "hp-sec-pairing", key: "pairingTitle" },
    { id: "hp-sec-repos", key: "reposTitle" },
    { id: "hp-sec-settings", key: "settingsTitle" },
    { id: "hp-sec-snippets", key: "snippetsTitle" },
    { id: "hp-sec-logs", key: "logsTitle" },
    { id: "hp-sec-service", key: "serviceTitle" },
    { id: "hp-sec-links", key: "linksTitle" }
  ];

  /** Scroll a card to the top of the viewport; no-ops if it has not rendered. */
  function jumpTo(id) {
    var el = typeof document !== "undefined" ? document.getElementById(id) : null;
    if (!el || !el.scrollIntoView) return;
    var reduced =
      typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      el.scrollIntoView({ block: "start" });
      return;
    }
    var before = window.scrollY;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    // A hidden tab (or a browser that drops the animation) never moves; land
    // instantly instead of leaving the reader where they tapped.
    setTimeout(function () {
      if (Math.abs(window.scrollY - before) < 2) el.scrollIntoView({ block: "start" });
    }, 350);
  }

  /** Wrapping chip row: one tap per card instead of scrolling a long page. */
  function SectionNav(props) {
    var t = props.t;
    return h(
      "nav",
      { className: "hp-nav", "aria-label": t.navLabel },
      SECTIONS.map(function (section) {
        return h(
          "button",
          {
            key: section.id,
            type: "button",
            className: "hp-nav-chip",
            "data-target": section.id,
            onClick: function () {
              jumpTo(section.id);
            }
          },
          t[section.key]
        );
      })
    );
  }

  /** EN / 日本語 segmented switch, mirrored by the Settings card's select. */
  function LangSwitch(props) {
    var t = props.t;
    var options = [
      { value: "en", label: "EN" },
      { value: "ja", label: "日本語" }
    ];
    return h(
      "div",
      { className: "hp-lang", role: "group", "aria-label": t.langLabel },
      options.map(function (option) {
        return h(
          "button",
          {
            key: "lang-" + option.value,
            type: "button",
            className: "hp-lang-btn" + (props.lang === option.value ? " hp-lang-active" : ""),
            "aria-pressed": props.lang === option.value,
            lang: option.value,
            onClick: function () {
              props.onChange(option.value);
            }
          },
          option.label
        );
      })
    );
  }

  // ------------------------------------------------------------------ sections

  function StatusBar(props) {
    var t = props.t;
    var s = props.status;
    if (!s) return h("div", { className: "hp-chips" }, h(Chip, { label: t.loading, value: "…" }));
    var svc = s.service || {};
    var stateLabel =
      svc.state === "running" ? t.running : svc.state === "stopped" ? t.stopped : t.unknownState;
    var manager = svc.manager && svc.manager !== "none" ? svc.manager : t.noManager;
    var bridge = s.bridge || {};
    return h(
      "div",
      { className: "hp-chips" },
      h(Chip, {
        label: t.service,
        value: manager + " · " + stateLabel,
        tone: svc.state === "running" ? "ok" : "muted"
      }),
      h(Chip, { label: t.port, value: String(s.port || "—") }),
      h(Chip, {
        label: t.bridge,
        value: bridge.reachable ? t.reachable : t.unreachable,
        tone: bridge.reachable ? "ok" : "bad"
      }),
      h(Chip, { label: t.version, value: bridge.version ? String(bridge.version) : "—" })
    );
  }

  function PairingSection(props) {
    var t = props.t;
    var dataState = useState(null);
    var data = dataState[0];
    var setData = dataState[1];
    var busyState = useState(false);
    var busy = busyState[0];
    var setBusy = busyState[1];
    var errState = useState(null);
    var err = errState[0];
    var setErr = errState[1];
    var nowState = useState(Date.now());
    var now = nowState[0];
    var setNow = nowState[1];
    var copiedState = useState("");
    var copied = copiedState[0];
    var setCopied = copiedState[1];

    var load = useCallback(function () {
      setBusy(true);
      return request("/pairing")
        .then(function (res) {
          if (res.status === 200 && res.body && res.body.qrPng) {
            setData(res.body);
            setErr(null);
          } else {
            setData(null);
            setErr(reasonOf(res, t.failed));
          }
          setBusy(false);
        })
        .catch(function (e) {
          setData(null);
          setErr(String((e && e.message) || e));
          setBusy(false);
        });
    }, []);

    useEffect(function () {
      load();
    }, [load]);

    var expiresAt = data && data.expiresAt ? Number(data.expiresAt) : 0;
    useEffect(
      function () {
        if (!expiresAt) return undefined;
        var id = setInterval(function () {
          setNow(Date.now());
        }, 1000);
        return function () {
          clearInterval(id);
        };
      },
      [expiresAt]
    );

    var targets = (data && data.targets) || [];
    var minutes = expiresAt ? Math.max(0, Math.ceil((expiresAt - (now || Date.now())) / 60000)) : 0;

    function copy(url) {
      copyText(url)
        .then(function () {
          setCopied(url);
          setTimeout(function () {
            setCopied("");
          }, 1500);
        })
        .catch(function () {
          setCopied("");
        });
    }

    return h(
      Card,
      { id: "hp-sec-pairing", title: t.pairingTitle, hint: t.pairingLead },
      err
        ? h("p", { className: "hp-error" }, t.pairingMissing + " (" + err + ")")
        : data
        ? h(
            "div",
            { className: "hp-pairing" },
            h("img", {
              className: "hp-qr",
              src: data.qrPng,
              width: QR_SIZE,
              height: QR_SIZE,
              alt: "Hermes Pilot pairing QR code"
            }),
            h(
              "div",
              { className: "hp-pairing-side" },
              h(
                "ol",
                { className: "hp-steps" },
                t.steps.map(function (step, i) {
                  return h("li", { key: "s" + i }, step);
                })
              ),
              h(
                "p",
                { className: "hp-expiry" + (minutes ? "" : " hp-expiry-over") },
                minutes ? t.expiresIn.replace("{n}", String(minutes)) : t.expired
              ),
              h(
                "ul",
                { className: "hp-targets" },
                targets.map(function (target, i) {
                  var url = (target && target.url) || "";
                  return h(
                    "li",
                    { key: "t" + i },
                    h("span", { className: "hp-target-label" }, (target && target.label) || url),
                    h("code", { className: "hp-url" }, url),
                    url
                      ? h(
                          "button",
                          {
                            type: "button",
                            className: "hp-btn hp-btn-sm",
                            onClick: function () {
                              copy(url);
                            }
                          },
                          copied === url ? t.copied : t.copy
                        )
                      : null
                  );
                })
              ),
              h(
                "button",
                { type: "button", className: "hp-btn", onClick: load, disabled: busy },
                busy ? t.loading : t.newCode
              )
            )
          )
        : h("p", { className: "hp-hint" }, busy ? t.loading : t.failed)
    );
  }

  function SettingsSection(props) {
    var t = props.t;
    var formState = useState(null);
    var form = formState[0];
    var setForm = formState[1];
    var errState = useState({});
    var errors = errState[0];
    var setErrors = errState[1];
    var noteState = useState(null);
    var note = noteState[0];
    var setNote = noteState[1];
    var busyState = useState(false);
    var busy = busyState[0];
    var setBusy = busyState[1];

    useEffect(function () {
      request("/config")
        .then(function (res) {
          var cfg = (res.body && res.body.config) || {};
          setForm({
            scanDirs: Array.isArray(cfg.scanDirs) ? cfg.scanDirs.join("\n") : "",
            tlsPort: cfg.tlsPort == null ? "" : String(cfg.tlsPort),
            tailscaleDns: cfg.tailscaleDns || "",
            servicePort: cfg.servicePort == null ? "" : String(cfg.servicePort)
          });
        })
        .catch(function (e) {
          setNote(String((e && e.message) || e));
        });
    }, []);

    function field(name, label, hint, type, wide) {
      var errCode = errors[name];
      var message = errCode ? (t.err[errCode] || errCode) : null;
      return h(
        "label",
        { className: "hp-field" + (wide ? " hp-field-wide" : "") + (errCode ? " hp-field-bad" : "") },
        h("span", { className: "hp-field-label" }, label),
        type === "area"
          ? h("textarea", {
              rows: 4,
              value: form[name],
              spellCheck: false,
              onChange: function (e) {
                var next = {};
                next[name] = e.target.value;
                setForm(Object.assign({}, form, next));
              }
            })
          : h("input", {
              type: "text",
              inputMode: "text",
              value: form[name],
              spellCheck: false,
              onChange: function (e) {
                var next = {};
                next[name] = e.target.value;
                setForm(Object.assign({}, form, next));
              }
            }),
        hint ? h("span", { className: "hp-field-hint" }, hint) : null,
        message ? h("span", { className: "hp-field-error" }, message) : null
      );
    }

    /**
     * `auto` / `en` / `ja` — the same choice the header's segmented switch makes,
     * so the select is driven by App's state instead of a second copy here.
     */
    function langField() {
      var value = props.langChoice || "auto";
      var errCode = errors.lang;
      return h(
        "label",
        { className: "hp-field" + (errCode ? " hp-field-bad" : "") },
        h("span", { className: "hp-field-label" }, t.langLabel),
        h(
          "select",
          {
            className: "hp-field-select",
            value: value,
            onChange: function (e) {
              // Immediate (SPEC V3 §3.5): labels and the snippet default language
              // switch on change; App also PUTs the choice to config.json.
              if (props.onLangChange) props.onLangChange(e.target.value);
            }
          },
          [
            { value: "auto", label: t.langAuto },
            { value: "en", label: "EN" },
            { value: "ja", label: "日本語" }
          ].map(function (option) {
            return h("option", { key: "lang-" + option.value, value: option.value }, option.label);
          })
        ),
        h("span", { className: "hp-field-hint" }, t.langHint),
        errCode ? h("span", { className: "hp-field-error" }, t.err[errCode] || errCode) : null
      );
    }

    if (!form) return h(Card, { id: "hp-sec-settings", title: t.settingsTitle }, h("p", { className: "hp-hint" }, t.loading));

    function save() {
      setBusy(true);
      setNote(null);
      var payload = {
        // `auto` is a legal config.json value (LANGUAGES): it means "follow the
        // browser", so the choice survives on this machine and on others.
        lang: props.langChoice || "auto",
        scanDirs: form.scanDirs,
        tlsPort: form.tlsPort === "" ? null : form.tlsPort,
        tailscaleDns: form.tailscaleDns,
        servicePort: form.servicePort === "" ? null : form.servicePort
      };
      request("/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      })
        .then(function (res) {
          if (res.status === 200 && res.body && res.body.ok) {
            setErrors({});
            // scanDirs is written to config.json *and* repos.json (G3).
            setNote(res.body.sync ? t.saved + " · repos.json" : t.saved);
            if (props.onSaved) props.onSaved();
          } else {
            setErrors((res.body && res.body.errors) || {});
            setNote(reasonOf(res, t.failed));
          }
          setBusy(false);
        })
        .catch(function (e) {
          setNote(String((e && e.message) || e));
          setBusy(false);
        });
    }

    return h(
      Card,
      { id: "hp-sec-settings", title: t.settingsTitle, hint: t.settingsLead },
      h(
        "div",
        { className: "hp-form" },
        langField(),
        field("scanDirs", t.scanDirs, t.scanDirsHint, "area", true),
        field("servicePort", t.servicePort, null, "text"),
        field("tlsPort", t.tlsPort, t.tlsPortHint, "text"),
        field("tailscaleDns", t.tailscaleDns, t.tailscaleDnsHint, "text")
      ),
      h(
        "div",
        { className: "hp-actions" },
        h("button", { type: "button", className: "hp-btn hp-btn-primary", onClick: save, disabled: busy }, busy ? t.saving : t.save),
        note ? h("span", { className: "hp-note" }, note) : null
      )
    );
  }

  function ServiceSection(props) {
    var t = props.t;
    var busyState = useState("");
    var busy = busyState[0];
    var setBusy = busyState[1];
    var outState = useState(null);
    var out = outState[0];
    var setOut = outState[1];
    var armedState = useState(false);
    var armed = armedState[0];
    var setArmed = armedState[1];
    var timer = useRef(null);

    useEffect(function () {
      return function () {
        if (timer.current) clearTimeout(timer.current);
      };
    }, []);

    function run(action) {
      setBusy(action);
      setOut(null);
      request("/service/" + action, { method: "POST" })
        .then(function (res) {
          var body = res.body || {};
          setOut((body.stdout || reasonOf(res, "")) + (body.ok ? "" : " (exit " + body.code + ")"));
          setBusy("");
          if (props.onChanged) props.onChanged();
        })
        .catch(function (e) {
          setOut(String((e && e.message) || e));
          setBusy("");
        });
    }

    function restart() {
      if (!armed) {
        setArmed(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(function () {
          setArmed(false);
        }, 5000);
        return;
      }
      if (timer.current) clearTimeout(timer.current);
      setArmed(false);
      run("restart");
    }

    return h(
      Card,
      { id: "hp-sec-service", title: t.serviceTitle, hint: t.serviceLead },
      h(
        "div",
        { className: "hp-actions" },
        h(
          "button",
          { type: "button", className: "hp-btn", onClick: function () { run("status"); }, disabled: Boolean(busy) },
          t.check
        ),
        h(
          "button",
          { type: "button", className: "hp-btn", onClick: function () { run("install"); }, disabled: Boolean(busy) },
          t.install
        ),
        h(
          "button",
          { type: "button", className: "hp-btn" + (armed ? " hp-btn-warn" : ""), onClick: restart, disabled: Boolean(busy) },
          armed ? t.restartArmed : t.restart
        )
      ),
      out
        ? h(
            "details",
            { className: "hp-out", open: true },
            h("summary", null, t.output),
            h("pre", null, out)
          )
        : null
    );
  }

  function LinksSection(props) {
    var t = props.t;
    var s = props.status || {};
    var links = [
      { label: t.lan, url: s.lanUrl },
      { label: t.tailscale, url: s.tailscaleUrl }
    ];
    return h(
      Card,
      { id: "hp-sec-links", title: t.linksTitle },
      h(
        "ul",
        { className: "hp-links" },
        links.map(function (link, i) {
          return h(
            "li",
            { key: "l" + i },
            h("span", { className: "hp-target-label" }, link.label),
            link.url
              ? h("a", { className: "hp-url", href: link.url, target: "_blank", rel: "noreferrer" }, link.url)
              : h("span", { className: "hp-hint" }, t.noLink)
          );
        })
      )
    );
  }

  // ------------------------------------------------------------- repositories

  /** A checkbox that reads as a chip (Hot / Hidden). */
  function Toggle(props) {
    return h(
      "label",
      { className: "hp-toggle" + (props.on ? " hp-toggle-on" : "") },
      h("input", {
        type: "checkbox",
        checked: Boolean(props.on),
        onChange: function (e) {
          props.onChange(e.target.checked);
        }
      }),
      h("span", null, props.label)
    );
  }

  function basename(value) {
    var parts = String(value || "").split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1] : String(value || "");
  }

  function RepositoriesSection(props) {
    var t = props.t;
    var dataState = useState(null);
    var data = dataState[0];
    var setData = dataState[1];
    var busyState = useState("");
    var busy = busyState[0];
    var setBusy = busyState[1];
    var errState = useState(null);
    var err = errState[0];
    var setErr = errState[1];
    var noteState = useState(null);
    var note = noteState[0];
    var setNote = noteState[1];
    var pathState = useState("");
    var path = pathState[0];
    var setPath = pathState[1];

    var load = useCallback(function () {
      return request("/repos")
        .then(function (res) {
          if (res.status === 200 && res.body && res.body.ok) {
            setData(res.body);
            setErr(null);
          } else {
            setErr(reasonOf(res, t.failed));
          }
        })
        .catch(function (e) {
          setErr(String((e && e.message) || e));
        });
    }, []);

    useEffect(
      function () {
        load();
      },
      [load, props.tick]
    );

    function act(action, extra) {
      setBusy(action);
      setNote(null);
      setErr(null);
      var body = Object.assign({ action: action }, extra || {});
      request("/repos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      })
        .then(function (res) {
          if (res.status === 200 && res.body && res.body.ok) {
            setNote(action === "createBoard" ? t.boardReady : t.reposSaved);
            load();
            if (props.onChanged) props.onChanged();
          } else {
            setErr(reasonOf(res, t.failed));
          }
          setBusy("");
        })
        .catch(function (e) {
          setErr(String((e && e.message) || e));
          setBusy("");
        });
    }

    var repos = (data && data.repos) || [];
    var hidden = (data && data.config && data.config.hidden) || [];
    var scanDirs = (data && data.scanDirs) || [];
    var fromFile = data && data.source === "file";

    return h(
      Card,
      { id: "hp-sec-repos", title: t.reposTitle, hint: t.reposLead },
      err ? h("p", { className: "hp-error" }, err) : null,
      fromFile ? h("p", { className: "hp-hint" }, t.repoFromFile) : null,
      h(
        "div",
        { className: "hp-actions hp-add-row" },
        h("input", {
          className: "hp-input",
          type: "text",
          placeholder: t.repoAddPlaceholder,
          value: path,
          spellCheck: false,
          onChange: function (e) {
            setPath(e.target.value);
          }
        }),
        h(
          "button",
          {
            type: "button",
            className: "hp-btn",
            disabled: Boolean(busy) || !String(path || "").trim(),
            onClick: function () {
              act("add", { path: path });
              setPath("");
            }
          },
          t.repoAdd
        ),
        h(
          "button",
          { type: "button", className: "hp-btn hp-btn-sm", onClick: load, disabled: Boolean(busy) },
          t.refresh
        )
      ),
      h(
        "p",
        { className: "hp-hint hp-scanhint" },
        h("strong", null, t.repoScanDirsLabel + ": "),
        h("span", { className: "hp-scanhint-value" }, scanDirs.join(" · ") || "—"),
        " ",
        t.repoScanDirsHint
      ),
      repos.length
        ? h(
            "ul",
            { className: "hp-repos" },
            repos.map(function (repo) {
              var boards = repo.boards || [];
              return h(
                "li",
                { key: "repo-" + repo.id, className: "hp-repo" },
                h(
                  "div",
                  { className: "hp-repo-main" },
                  h("strong", { className: "hp-repo-label" }, repo.label),
                  h("code", { className: "hp-repo-path" }, repo.path),
                  h("span", { className: "hp-badge" }, repo.source)
                ),
                h(
                  "div",
                  { className: "hp-repo-actions" },
                  h(
                    "button",
                    {
                      type: "button",
                      className: "hp-btn hp-btn-sm",
                      onClick: function () {
                        act(repo.pinned ? "unpin" : "pin", { id: repo.id });
                      }
                    },
                    repo.pinned ? t.unpin : t.pin
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      className: "hp-btn hp-btn-sm",
                      onClick: function () {
                        act("hide", { id: repo.id });
                      }
                    },
                    t.hide
                  ),
                  boards.length
                    ? boards.map(function (b) {
                        return h("span", { key: "board-" + (b.slug || b.name), className: "hp-badge hp-badge-ok" }, b.name || b.slug);
                      })
                    : h(
                        "button",
                        {
                          type: "button",
                          className: "hp-btn hp-btn-sm",
                          disabled: Boolean(busy),
                          onClick: function () {
                            act("createBoard", { id: repo.id });
                          }
                        },
                        t.boardCreate
                      )
                )
              );
            })
          )
        : h("p", { className: "hp-hint" }, data ? t.repoEmpty : t.loading),
      h(
        "div",
        { className: "hp-sub" },
        h("h3", null, t.hiddenTitle + (hidden.length ? " (" + hidden.length + ")" : "")),
        hidden.length
          ? h(
              "ul",
              { className: "hp-repos hp-repos-hidden" },
              hidden.map(function (item, i) {
                return h(
                  "li",
                  { key: "hidden-" + i, className: "hp-repo" },
                  h("div", { className: "hp-repo-main" }, h("span", { className: "hp-target-label" }, basename(item)), h("code", { className: "hp-repo-path" }, item)),
                  h(
                    "div",
                    { className: "hp-repo-actions" },
                    h(
                      "button",
                      {
                        type: "button",
                        className: "hp-btn hp-btn-sm",
                        onClick: function () {
                          act("unhide", { id: item });
                        }
                      },
                      t.unhide
                    )
                  )
                );
              })
            )
          : h("p", { className: "hp-hint" }, t.hiddenNone)
      ),
      note ? h("p", { className: "hp-note" }, note) : null
    );
  }

  // ----------------------------------------------------------------- snippets

  function SnippetsSection(props) {
    var t = props.t;
    var kindState = useState("chat");
    var kind = kindState[0];
    var setKind = kindState[1];
    var langState = useState(props.lang || "en");
    var lang = langState[0];
    var setLang = langState[1];
    var dataState = useState(null);
    var data = dataState[0];
    var setData = dataState[1];
    var overridesState = useState({});
    var overrides = overridesState[0];
    var setOverrides = overridesState[1];
    var customState = useState([]);
    var custom = customState[0];
    var setCustom = customState[1];
    var busyState = useState("");
    var busy = busyState[0];
    var setBusy = busyState[1];
    var errState = useState(null);
    var err = errState[0];
    var setErr = errState[1];
    var noteState = useState(null);
    var note = noteState[0];
    var setNote = noteState[1];
    var armedState = useState(false);
    var armed = armedState[0];
    var setArmed = armedState[1];
    var timer = useRef(null);

    var load = useCallback(
      function () {
        setBusy("load");
        return request("/snippets?kind=" + kind + "&lang=" + lang)
          .then(function (res) {
            if (res.status === 200 && res.body && res.body.ok) {
              setData(res.body);
              setOverrides(res.body.overrides || {});
              setCustom(res.body.custom || []);
              setErr(null);
            } else {
              setErr(reasonOf(res, t.failed));
            }
            setBusy("");
          })
          .catch(function (e) {
            setErr(String((e && e.message) || e));
            setBusy("");
          });
      },
      [kind, lang]
    );

    useEffect(
      function () {
        load();
      },
      [load]
    );

    useEffect(function () {
      return function () {
        if (timer.current) clearTimeout(timer.current);
      };
    }, []);

    // The header's EN / 日本語 switch owns the snippet default language
    // (SPEC V3 §3.5). The local EN/JA tabs remain, but the tab re-syncs when the
    // header changes so both always agree on the default.
    useEffect(
      function () {
        setLang(props.lang === "ja" ? "ja" : "en");
      },
      [props.lang]
    );

    function save(body, done) {
      setBusy("save");
      setNote(null);
      setErr(null);
      request("/snippets?kind=" + kind + "&lang=" + lang, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      })
        .then(function (res) {
          if (res.status === 200 && res.body && res.body.ok) {
            setData(res.body);
            setOverrides(res.body.overrides || {});
            setCustom(res.body.custom || []);
            setNote(done || t.saved);
            if (props.onChanged) props.onChanged();
          } else {
            setErr(reasonOf(res, t.failed));
          }
          setBusy("");
        })
        .catch(function (e) {
          setErr(String((e && e.message) || e));
          setBusy("");
        });
    }

    function override(id, patch) {
      var current = overrides[id] || {};
      var next = Object.assign({}, overrides);
      next[id] = Object.assign({}, current, patch);
      setOverrides(next);
    }

    function editCustom(index, patch) {
      setCustom(
        custom.map(function (item, i) {
          return i === index ? Object.assign({}, item, patch) : item;
        })
      );
    }

    function resetNow() {
      if (!armed) {
        setArmed(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(function () {
          setArmed(false);
        }, 5000);
        return;
      }
      if (timer.current) clearTimeout(timer.current);
      setArmed(false);
      save({ reset: true }, t.saved);
    }

    var all = (data && data.allSnippets) || [];
    var builtin = all.filter(function (item) {
      return !item.custom;
    });
    var fromFile = data && data.source === "file";

    function tabButton(value, label) {
      return h(
        "button",
        {
          type: "button",
          className: "hp-tab" + (kind === value ? " hp-tab-active" : ""),
          onClick: function () {
            setKind(value);
          }
        },
        label
      );
    }

    return h(
      Card,
      { id: "hp-sec-snippets", title: t.snippetsTitle, hint: t.snippetsLead },
      err ? h("p", { className: "hp-error" }, err) : null,
      h(
        "div",
        { className: "hp-tabs" },
        tabButton("chat", t.tabChat),
        tabButton("term", t.tabTerm),
        h(
          "button",
          {
            type: "button",
            className: "hp-tab" + (lang === "en" ? " hp-tab-active" : ""),
            onClick: function () {
              setLang("en");
            }
          },
          "EN"
        ),
        h(
          "button",
          {
            type: "button",
            className: "hp-tab" + (lang === "ja" ? " hp-tab-active" : ""),
            onClick: function () {
              setLang("ja");
            }
          },
          "JA"
        )
      ),
      fromFile ? h("p", { className: "hp-hint" }, t.snippetsFileOnly) : null,
      builtin.length
        ? h(
            "ul",
            { className: "hp-snippets" },
            builtin.map(function (item) {
              var ov = overrides[item.id] || {};
              var hot = typeof ov.hot === "boolean" ? ov.hot : item.hot;
              var hid = typeof ov.hidden === "boolean" ? ov.hidden : item.hidden;
              return h(
                "li",
                { key: "snip-" + item.id, className: "hp-snippet" },
                h(
                  "div",
                  { className: "hp-snippet-head" },
                  h("strong", null, item.label),
                  h("code", { className: "hp-snippet-id" }, item.id),
                  h(
                    "div",
                    { className: "hp-snippet-toggles" },
                    h(Toggle, {
                      label: t.hot,
                      on: hot,
                      onChange: function (next) {
                        override(item.id, { hot: next });
                      }
                    }),
                    h(Toggle, {
                      label: t.hiddenTag,
                      on: hid,
                      onChange: function (next) {
                        override(item.id, { hidden: next });
                      }
                    })
                  )
                ),
                h("p", { className: "hp-snippet-text" }, item.text)
              );
            })
          )
        : null,
      h(
        "div",
        { className: "hp-sub" },
        h("h3", null, t.snippetNew + (custom.length ? " (" + custom.length + ")" : "")),
        custom.map(function (item, index) {
          return h(
            "div",
            { key: "custom-" + index, className: "hp-custom" },
            h(
              "div",
              { className: "hp-custom-row" },
              h("input", {
                className: "hp-input hp-input-sm",
                type: "text",
                placeholder: t.snippetLabel,
                value: item.label || "",
                onChange: function (e) {
                  editCustom(index, { label: e.target.value });
                }
              }),
              h(Toggle, {
                label: t.hot,
                on: Boolean(item.hot),
                onChange: function (next) {
                  editCustom(index, { hot: next });
                }
              }),
              kind === "term"
                ? h(Toggle, {
                    label: t.snippetRun,
                    on: item.run !== false,
                    onChange: function (next) {
                      editCustom(index, { run: next });
                    }
                  })
                : null,
              h(
                "button",
                {
                  type: "button",
                  className: "hp-btn hp-btn-sm",
                  onClick: function () {
                    setCustom(
                      custom.filter(function (_, i) {
                        return i !== index;
                      })
                    );
                  }
                },
                t.remove
              )
            ),
            h("textarea", {
              className: "hp-input hp-textarea",
              rows: 2,
              value: item.text || "",
              placeholder: t.snippetText,
              onChange: function (e) {
                editCustom(index, { text: e.target.value });
              }
            })
          );
        }),
        h(
          "button",
          {
            type: "button",
            className: "hp-btn hp-btn-sm",
            onClick: function () {
              setCustom(
                custom.concat([
                  {
                    id: "c-" + Math.random().toString(36).slice(2, 6),
                    label: "",
                    text: "",
                    hot: false,
                    run: true
                  }
                ])
              );
            }
          },
          t.snippetNew
        )
      ),
      h(
        "div",
        { className: "hp-actions" },
        h(
          "button",
          {
            type: "button",
            className: "hp-btn hp-btn-primary",
            disabled: Boolean(busy),
            onClick: function () {
              save({ custom: custom, overrides: overrides }, t.saved);
            }
          },
          busy === "save" ? t.saving : t.saveSnippets
        ),
        h(
          "button",
          {
            type: "button",
            className: "hp-btn" + (armed ? " hp-btn-warn" : ""),
            disabled: Boolean(busy),
            onClick: resetNow
          },
          armed ? t.resetArmed : t.resetSnippets
        ),
        note ? h("span", { className: "hp-note" }, note) : null
      )
    );
  }

  // --------------------------------------------------------------------- logs

  var LOG_FILES = ["gateway", "errors", "pilot", "audit"];

  function LogsSection(props) {
    var t = props.t;
    var nameState = useState("gateway");
    var name = nameState[0];
    var setName = nameState[1];
    var linesState = useState(120);
    var lines = linesState[0];
    var setLines = linesState[1];
    var dataState = useState(null);
    var data = dataState[0];
    var setData = dataState[1];
    var busyState = useState(false);
    var busy = busyState[0];
    var setBusy = busyState[1];
    var errState = useState(null);
    var err = errState[0];
    var setErr = errState[1];
    // Audit card: newest 8 rows, the rest behind one accordion (SPEC V3 §3.5).
    var expandedState = useState(false);
    var expanded = expandedState[0];
    var setExpanded = expandedState[1];
    var rawState = useState(false);
    var rawView = rawState[0];
    var setRawView = rawState[1];

    var load = useCallback(
      function () {
        setBusy(true);
        return request("/logs?file=" + name + "&lines=" + lines)
          .then(function (res) {
            if (res.status === 200 && res.body && res.body.ok) {
              setData(res.body);
              setErr(null);
            } else {
              setErr(reasonOf(res, t.failed));
            }
            setBusy(false);
          })
          .catch(function (e) {
            setErr(String((e && e.message) || e));
            setBusy(false);
          });
      },
      [name, lines]
    );

    useEffect(
      function () {
        load();
      },
      [load]
    );

    // Switching files starts collapsed again, so the card never grows silently.
    useEffect(
      function () {
        setExpanded(false);
        setRawView(false);
      },
      [name, lines]
    );

    var labels = { gateway: t.logGateway, errors: t.logErrors, pilot: t.logPilot, audit: t.logAudit };
    var body = (data && data.lines) || [];
    var text = body.length ? body.join("\n") : data && data.missing ? t.logMissing : t.logEmpty;
    var isAudit = name === "audit";
    // Older backends only send `lines`; parse them here so both shapes render.
    var auditEntries = isAudit ? (Array.isArray(data && data.entries) ? data.entries : parseAuditLines(body)) : [];
    var auditHead = auditEntries.slice(0, AUDIT_VISIBLE);
    var auditRest = auditEntries.slice(AUDIT_VISIBLE);
    var auditShown = expanded ? auditEntries : auditHead;

    return h(
      Card,
      { id: "hp-sec-logs", title: t.logsTitle, hint: t.logsLead },
      err ? h("p", { className: "hp-error" }, err) : null,
      h(
        "div",
        { className: "hp-actions" },
        LOG_FILES.map(function (value) {
          return h(
            "button",
            {
              key: "log-" + value,
              type: "button",
              className: "hp-tab" + (name === value ? " hp-tab-active" : ""),
              onClick: function () {
                setName(value);
              }
            },
            labels[value]
          );
        }),
        h(
          "select",
          {
            className: "hp-select",
            value: String(lines),
            onChange: function (e) {
              setLines(Number(e.target.value));
            }
          },
          [60, 120, 300].map(function (n) {
            return h("option", { key: "n" + n, value: String(n) }, String(n));
          })
        ),
        h(
          "button",
          { type: "button", className: "hp-btn hp-btn-sm", onClick: load, disabled: busy },
          t.refresh
        )
      ),
      h("p", { className: "hp-hint hp-log-meta" }, (data && data.path) || "", data ? " · " + body.length : ""),
      isAudit
        ? h(
            "div",
            { className: "hp-audit-toggle" },
            h(
              "button",
              {
                type: "button",
                className: "hp-tab" + (rawView ? "" : " hp-tab-active"),
                "aria-pressed": !rawView,
                onClick: function () {
                  setRawView(false);
                }
              },
              t.auditList
            ),
            h(
              "button",
              {
                type: "button",
                className: "hp-tab" + (rawView ? " hp-tab-active" : ""),
                "aria-pressed": rawView,
                onClick: function () {
                  setRawView(true);
                }
              },
              t.auditRaw
            )
          )
        : null,
      isAudit && !rawView
        ? auditShown.length
          ? h(
              "ul",
              { className: "hp-audit" },
              auditShown.map(function (entry, i) {
                var tone = entry.ok === false ? " hp-audit-bad" : entry.ok === true ? " hp-audit-ok" : "";
                return h(
                  "li",
                  { key: "audit-" + i, className: "hp-audit-row" + tone },
                  h(
                    "div",
                    { className: "hp-audit-head" },
                    h("span", { className: "hp-audit-kind" }, entry.kind || "—"),
                    h("span", { className: "hp-audit-at" }, shortTime(entry.at))
                  ),
                  entry.detail ? h("p", { className: "hp-audit-detail" }, entry.detail) : null
                );
              })
            )
          : h("p", { className: "hp-hint" }, data && data.missing ? t.logMissing : t.auditEmpty)
        : h("pre", { className: "hp-log" }, text),
      isAudit && !rawView && auditRest.length
        ? h(
            "button",
            {
              type: "button",
              className: "hp-btn hp-btn-sm hp-audit-more",
              "aria-expanded": expanded,
              onClick: function () {
                setExpanded(!expanded);
              }
            },
            expanded ? t.auditCollapse : t.auditShowMore.replace("{n}", String(auditRest.length))
          )
        : null
    );
  }

  // ------------------------------------------------------------------ root

  function App() {
    // uiLang: an explicit choice in this browser wins; otherwise config.json's ja,
    // otherwise the browser language (SPEC V3 §3.5 / D5).
    var storedLang = readStoredLang();
    var langState = useState(storedLang || detectLang());
    var lang = langState[0];
    var setLang = langState[1];
    // What the Settings select shows: the explicit choice, or `auto`.
    var choiceState = useState(storedLang || "auto");
    var langChoice = choiceState[0];
    var setLangChoice = choiceState[1];
    var hasLocalPref = useRef(Boolean(storedLang));
    var t = STRINGS[lang] || STRINGS.en;
    var statusState = useState(null);
    var status = statusState[0];
    var setStatus = statusState[1];
    var errState = useState(null);
    var err = errState[0];
    var setErr = errState[1];
    // Bumped when Settings saves, so the Repositories card re-reads scanDirs.
    var tickState = useState(0);
    var tick = tickState[0];
    var setTick = tickState[1];

    function bump() {
      setTick(function (n) {
        return n + 1;
      });
    }

    /**
     * `en` / `ja` apply at once and persist to config.json; `auto` forgets the
     * local choice and falls back to config + browser (that is what the Settings
     * select's third option means, and it is never written to config.json).
     */
    var changeLang = useCallback(function (next) {
      if (next === "auto") {
        writeStoredLang(null);
        hasLocalPref.current = false;
        setLangChoice("auto");
        setLang(detectLang());
        saveLang("auto");
        return;
      }
      if (next !== "en" && next !== "ja") return;
      writeStoredLang(next);
      hasLocalPref.current = true;
      setLangChoice(next);
      setLang(next);
      saveLang(next);
    }, []);

    // Follow config.json on first load, unless this browser already chose.
    useEffect(function () {
      request("/config")
        .then(function (res) {
          if (!(res.status === 200 && res.body && res.body.ok)) return;
          if (hasLocalPref.current) return;
          var cfg = res.body.config || {};
          // `ja` in config.json is a deliberate choice elsewhere, so mirror it in
          // the select; `en` is also the init default and stays `auto`.
          setLangChoice(cfg.lang === "ja" ? "ja" : "auto");
          var next = pickLang(null, cfg.lang, detectLang());
          setLang(function (prev) {
            return next === prev ? prev : next;
          });
        })
        .catch(function () {
          /* the status card already reports an unreachable backend */
        });
    }, []);

    var load = useCallback(function () {
      return request("/status")
        .then(function (res) {
          if (res.status === 200 && res.body && res.body.ok) {
            setStatus(res.body);
            setErr(null);
          } else {
            setErr(reasonOf(res, t.failed));
          }
        })
        .catch(function (e) {
          setErr(String((e && e.message) || e));
        });
    }, []);

    useEffect(function () {
      load();
    }, [load]);

    return h(
      "div",
      { className: "hp-root" },
      h(
        "div",
        { className: "hp-header" },
        h("div", { className: "hp-heading" }, h("h1", null, t.title), h("p", null, t.lead)),
        h(
          "div",
          { className: "hp-head-actions" },
          h(LangSwitch, { t: t, lang: lang, onChange: changeLang }),
          h(
            "button",
            { type: "button", className: "hp-btn", onClick: load },
            t.refresh
          )
        )
      ),
      err ? h("p", { className: "hp-error" }, t.failed + ": " + err) : null,
      h(StatusBar, { t: t, status: status }),
      h(SectionNav, { t: t }),
      h(PairingSection, { t: t }),
      h(RepositoriesSection, { t: t, tick: tick, onChanged: load }),
      h(SettingsSection, { t: t, onSaved: bump, onLangChange: changeLang, langChoice: langChoice }),
      h(SnippetsSection, { t: t, lang: lang, onChanged: load }),
      h(LogsSection, { t: t }),
      h(ServiceSection, { t: t, onChanged: load }),
      h(LinksSection, { t: t, status: status })
    );
  }

  window.__HERMES_PLUGINS__.register("hermes-pilot", App);
})();
