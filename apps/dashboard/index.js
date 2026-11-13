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
      { className: "hp-card" },
      h(
        "header",
        { className: "hp-card-head" },
        h("h2", null, props.title),
        props.hint ? h("p", { className: "hp-hint" }, props.hint) : null
      ),
      props.children
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
      { title: t.pairingTitle, hint: t.pairingLead },
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
            lang: cfg.lang || "en",
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

    if (!form) return h(Card, { title: t.settingsTitle }, h("p", { className: "hp-hint" }, t.loading));

    function save() {
      setBusy(true);
      setNote(null);
      var payload = {
        lang: form.lang,
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
            setNote(t.saved);
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
      { title: t.settingsTitle, hint: t.settingsLead },
      h(
        "div",
        { className: "hp-form" },
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
      { title: t.serviceTitle, hint: t.serviceLead },
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
      { title: t.linksTitle },
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

  // ------------------------------------------------------------------ root

  function App() {
    var t = STRINGS[detectLang()] || STRINGS.en;
    var statusState = useState(null);
    var status = statusState[0];
    var setStatus = statusState[1];
    var errState = useState(null);
    var err = errState[0];
    var setErr = errState[1];

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
          "button",
          { type: "button", className: "hp-btn", onClick: load },
          t.refresh
        )
      ),
      err ? h("p", { className: "hp-error" }, t.failed + ": " + err) : null,
      h(StatusBar, { t: t, status: status }),
      h(PairingSection, { t: t }),
      h(SettingsSection, { t: t }),
      h(ServiceSection, { t: t, onChanged: load }),
      h(LinksSection, { t: t, status: status })
    );
  }

  window.__HERMES_PLUGINS__.register("hermes-pilot", App);
})();
