"""Logic behind the Hermes Pilot tab on the standard Hermes dashboard.

The FastAPI shim (``plugin_api.py``) deliberately stays thin: everything that can
be wrong — config validation, the atomic write, service probing, the bridge call,
and above all *not* leaking the app token to the browser — lives here so it can
be tested without FastAPI, a live bridge, or a real launchd/systemd.

Design notes
------------
* **Token never leaves this process.** The bridge accepts ``?t=<token>`` for GET
  requests (``apps/bridge/src/auth.js`` → ``authorized``). We read the token from
  ``<dataDir>/token`` (0600) only to call the bridge from Python, and every
  payload that goes back to the browser is passed through :func:`redact`.
* **Stdlib only.** No ``requests``; ``urllib`` is enough for a few loopback GETs.
* **Injected side effects.** Service probing, the bridge fetch, LAN detection and
  the CLI spawn are parameters with real defaults, so tests pass fakes.
"""

from __future__ import annotations

import json
import os
import platform as platform_module
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Optional

#: Bridge default port (SPEC §8.1).
DEFAULT_PORT = 4097
#: Bridge binds loopback; the dashboard plugin talks to it server-side.
BRIDGE_HOST = "127.0.0.1"
#: Service unit per platform (SPEC §5.3 / D9).
SERVICE_UNITS = {"darwin": "ai.hermes.pilot", "linux": "hermes-pilot.service"}
SERVICE_MANAGERS = {"darwin": "launchd", "linux": "systemd"}
#: Repository scan roots (`repos.json` defaults, SPEC §5.1).
DEFAULT_SCAN_DIRS = ["~/Projects", "~/projects"]
#: Config keys this tab owns.
CONFIG_FIELDS = ("lang", "scanDirs", "tlsPort", "tailscaleDns", "servicePort")
#: Allowed UI languages (SPEC D5: English default + Japanese).
LANGUAGES = ("en", "ja", "auto")
#: Service actions the tab may trigger (SPEC §8.1).
SERVICE_ACTIONS = ("install", "restart", "status")
#: `POST /repos` actions (SPEC §4.1 — Repositories card, closes G3).
REPO_ACTIONS = ("add", "hide", "unhide", "pin", "unpin", "createBoard")
#: Snippet kinds and the bridge route each one lives on (SPEC §4.2 / §3.2).
SNIPPET_KINDS = ("chat", "term")
#: Snippet limits mirrored from `apps/bridge/src/snippets.js`.
LABEL_MAX = 20
TEXT_MAX = 400
CUSTOM_MAX = 16
HOT_LIMIT = 8
#: Log files the tab may show (SPEC §4.2). `audit` is the bridge's JSONL trail.
LOG_FILES = {
    "gateway": ("gateway.log",),
    "errors": ("errors.log",),
    "pilot": ("pilot.out.log", "pilot.err.log"),
    "audit": (),
}
#: `?token=…` / `&t=…` in a log line — the bridge logs pairing URLs, and a
#: pairing code is still a credential until it expires.
LOG_QUERY_SECRET = re.compile(r"([?&](?:token|t)=)[^&\s\"'<>]+")
#: A log response is bounded: 1000 lines from the last 256 KiB.
LOG_LINES_MAX = 1000
LOG_READ_BYTES = 256 * 1024
#: `c-<base36>` custom snippet ids, same pattern the bridge accepts.
CUSTOM_ID_RE = re.compile(r"^c-[a-z0-9]{1,20}$")
#: Anything that looks like the 256-bit hex app token, or another hex secret.
HEX_SECRET = re.compile(r"[0-9a-fA-F]{32,}")
#: Hostname (RFC 1123) — used to validate ``tailscaleDns``.
HOSTNAME_RE = re.compile(
    r"^(?=.{1,253}\.?$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
    r"(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?$"
)


class BridgeUnavailable(RuntimeError):
    """The bridge (:4097) did not answer — the tab reports this, it never crashes."""


class MissingCli(RuntimeError):
    """``hermes-pilot init`` was never run in this HERMES_HOME."""


# --------------------------------------------------------------------------- paths


def hermes_home(env: Optional[Mapping[str, str]] = None) -> Path:
    """Resolve ``HERMES_HOME``, unwrapping a profile directory.

    Worker/cron processes point ``HERMES_HOME`` at ``~/.hermes/profiles/<name>``;
    the same correction as ``bin/hermes-pilot.mjs`` / ``apps/bridge/src/config.js``.
    """
    env = os.environ if env is None else env
    home = Path(env.get("HOME") or Path.home())
    raw = env.get("HERMES_HOME") or str(home / ".hermes")
    resolved = Path(os.path.expanduser(str(raw)))
    if resolved.parent.name == "profiles":
        return resolved.parent.parent
    return resolved


def resolve_paths(env: Optional[Mapping[str, str]] = None) -> dict[str, Path]:
    """Plugin data paths (SPEC §3.2 / D1)."""
    env = os.environ if env is None else env
    home = Path(env.get("HOME") or Path.home())
    hh = hermes_home(env)
    data_dir = Path(env.get("HP_DATA_DIR") or os.path.expanduser(str(hh / "plugin-data" / "hermes-pilot")))
    # Same override the bridge honours (`apps/bridge/src/config.js`), so both
    # processes read and write one `repos.json`.
    repos_path = Path(env.get("HP_REPOS_JSON") or os.path.expanduser(str(data_dir / "repos.json")))
    return {
        "home": home,
        "hermesHome": hh,
        "dataDir": data_dir,
        "configPath": data_dir / "config.json",
        "tokenPath": data_dir / "token",
        # Written by `hermes-pilot init`: where the CLI lives, so `service` can spawn it.
        "dashboardMetaPath": data_dir / "dashboard.json",
        # Repository settings (scanDirs / pinned / hidden / custom) — G3: one file,
        # edited from either the PWA or this tab.
        "reposPath": repos_path,
        # Snippet stores (SPEC §3.2 / §4.2): built-in overrides + custom entries.
        "snippetsPath": data_dir / "snippets.json",
        "termSnippetsPath": data_dir / "term-snippets.json",
        # Logs & audit card (SPEC §4.2).
        "auditPath": data_dir / "audit.jsonl",
        "logDir": hh / "logs",
    }


def read_token(paths: Mapping[str, Path]) -> Optional[str]:
    """Read the app token (never returned to the browser)."""
    try:
        token = Path(paths["tokenPath"]).read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return token or None


def read_dashboard_meta(paths: Mapping[str, Path]) -> Optional[dict[str, Any]]:
    """Where the CLI lives, as recorded by ``hermes-pilot init``."""
    try:
        raw = json.loads(Path(paths["dashboardMetaPath"]).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(raw, dict) or not raw.get("cli"):
        return None
    return raw


# --------------------------------------------------------------------------- config


def default_config(port: int = DEFAULT_PORT) -> dict[str, Any]:
    """Config shape written by ``hermes-pilot init`` (SPEC §3.2)."""
    return {"lang": "en", "scanDirs": list(DEFAULT_SCAN_DIRS), "tlsPort": None, "tailscaleDns": None, "servicePort": port}


def read_config(config_path: Path | str) -> dict[str, Any]:
    """Read ``config.json``, tolerating a missing or half-written file."""
    cfg = default_config()
    try:
        raw = json.loads(Path(config_path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return cfg
    if not isinstance(raw, dict):
        return cfg
    if isinstance(raw.get("lang"), str) and raw["lang"] in LANGUAGES:
        cfg["lang"] = raw["lang"]
    if isinstance(raw.get("scanDirs"), list):
        dirs = [str(d).strip() for d in raw["scanDirs"] if str(d).strip()]
        if dirs:
            cfg["scanDirs"] = dirs
    raw_port = raw.get("servicePort")
    if raw_port is not None and str(raw_port).strip():
        try:
            cfg["servicePort"] = int(str(raw_port).strip())
        except (TypeError, ValueError):
            cfg["servicePort"] = DEFAULT_PORT
    else:
        cfg["servicePort"] = DEFAULT_PORT
    try:
        tls = raw.get("tlsPort")
        cfg["tlsPort"] = int(tls) if tls not in (None, "", 0) else None
    except (TypeError, ValueError):
        cfg["tlsPort"] = None
    dns = raw.get("tailscaleDns")
    cfg["tailscaleDns"] = str(dns).strip().rstrip(".") if isinstance(dns, str) and dns.strip() else None
    return cfg


def expand_path(value: str, home: Optional[Path] = None) -> str:
    """Expand ``~`` against *home* (not the process user, so tests can redirect it)."""
    home = Path(home) if home is not None else Path.home()
    text = str(value).strip()
    if text == "~":
        return str(home)
    if text.startswith("~/"):
        return str(home / text[2:])
    return text


def shorten_path(path: str, home: Optional[Path] = None) -> str:
    """Store paths ``~``-relative so ``config.json`` stays portable across machines."""
    home = Path(home) if home is not None else Path.home()
    try:
        rel = Path(path).relative_to(home)
    except ValueError:
        return str(path)
    return "~" if str(rel) == "." else f"~/{rel}"


def _coerce_port(
    raw: Any, field: str, errors: dict[str, str], messages: dict[str, str], *, allow_null: bool = False
) -> Optional[int]:
    """Validate a TCP port; ``None`` means "not configured" when *allow_null*."""
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        if allow_null:
            return None
        errors[field] = "required"
        messages[field] = "A port is required"
        return None
    try:
        value = int(str(raw).strip())
    except (TypeError, ValueError):
        errors[field] = "not_a_number"
        messages[field] = "Port must be a number between 1 and 65535"
        return None
    if not 1 <= value <= 65535:
        errors[field] = "out_of_range"
        messages[field] = "Port must be between 1 and 65535"
        return None
    return value


def validate_config(
    payload: Any,
    *,
    home: Optional[Path] = None,
    is_dir: Optional[Callable[[str], bool]] = None,
) -> dict[str, Any]:
    """Validate a ``PUT /config`` body (SPEC §8.1 contract for ``config.json``).

    ``scanDirs`` must be real directories (``~`` expanded), ports must be
    1..65535 and ``tailscaleDns`` a hostname. Returns per-field error *codes* plus
    English messages so the browser can localise the code it knows about.
    """
    home_path = Path(home) if home is not None else Path.home()
    is_dir = is_dir or os.path.isdir
    raw: Mapping[str, Any] = payload if isinstance(payload, Mapping) else {}

    errors: dict[str, str] = {}
    messages: dict[str, str] = {}
    value: dict[str, Any] = {}

    lang = raw.get("lang", "en")
    if lang not in LANGUAGES:
        errors["lang"] = "invalid_lang"
        messages["lang"] = f"Language must be one of {', '.join(LANGUAGES)}"
    else:
        value["lang"] = lang

    dirs: Any = raw.get("scanDirs", list(DEFAULT_SCAN_DIRS))
    if isinstance(dirs, str):
        dirs = dirs.splitlines()
    if not isinstance(dirs, list):
        errors["scanDirs"] = "invalid_list"
        messages["scanDirs"] = "Scan directories must be a list"
    else:
        cleaned: list[str] = []
        bad: Optional[str] = None
        bad_code = "not_a_directory"
        for item in dirs:
            text = str(item).strip()
            if not text:
                continue
            absolute = expand_path(text, home_path)
            if Path(absolute) == home_path:
                # Scanning `~` itself walks every project, node_modules included.
                bad = text
                bad_code = "home_directory"
                break
            if not is_dir(absolute):
                bad = text
                bad_code = "not_a_directory"
                break
            short = shorten_path(absolute, home_path)
            if short not in cleaned:
                cleaned.append(short)
        if bad is not None:
            errors["scanDirs"] = bad_code
            messages["scanDirs"] = (
                f"{bad} is the home directory itself — pick the folders under it"
                if bad_code == "home_directory"
                else f"{bad} is not an existing directory"
            )
        elif not cleaned:
            errors["scanDirs"] = "empty"
            messages["scanDirs"] = "Register at least one directory to scan"
        else:
            cleaned = _dedupe_scan_dirs(cleaned, home_path)
            if len(cleaned) > 20:
                errors["scanDirs"] = "too_many"
                messages["scanDirs"] = "At most 20 scan directories"
            else:
                value["scanDirs"] = cleaned

    tls_port = _coerce_port(raw.get("tlsPort"), "tlsPort", errors, messages, allow_null=True)
    if "tlsPort" not in errors:
        value["tlsPort"] = tls_port

    service_port = _coerce_port(raw.get("servicePort"), "servicePort", errors, messages)
    if "servicePort" not in errors:
        value["servicePort"] = service_port

    dns = raw.get("tailscaleDns")
    dns_text = str(dns).strip().rstrip(".") if isinstance(dns, str) else ""
    if dns_text and not HOSTNAME_RE.match(dns_text):
        errors["tailscaleDns"] = "invalid_hostname"
        messages["tailscaleDns"] = "Use a hostname such as machine.tailnet-name.ts.net"
    else:
        value["tailscaleDns"] = dns_text or None

    return {"ok": not errors, "errors": errors, "messages": messages, "value": value}


def write_config_atomic(config_path: Path | str, value: Mapping[str, Any]) -> dict[str, Any]:
    """Write ``config.json`` via tmp → rename, mode 0600 (SPEC §8.1)."""
    target = Path(config_path)
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    payload = {key: value.get(key) for key in CONFIG_FIELDS if key in value}
    body = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    fd, tmp_name = tempfile.mkstemp(dir=str(target.parent), prefix=".config-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(body)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp_name, 0o600)
        os.replace(tmp_name, target)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise
    return payload


# --------------------------------------------------------------------------- service


def _run(argv: list[str], timeout: float = 4.0) -> tuple[int, str]:
    """Run a probe/command, returning ``(exit code, stdout+stderr)`` — never raising."""
    try:
        proc = subprocess.run(
            argv, capture_output=True, text=True, timeout=timeout, check=False
        )
    except (OSError, subprocess.SubprocessError) as exc:  # missing binary, timeout
        return -1, str(exc)
    return proc.returncode, f"{proc.stdout or ''}{proc.stderr or ''}".strip()


def service_key(platform: Optional[str] = None) -> Optional[str]:
    """Normalise ``sys.platform`` to a unit-table key."""
    name = platform or sys.platform
    if name == "darwin":
        return "darwin"
    if name.startswith("linux"):
        return "linux"
    return None


def service_status(
    *,
    platform: Optional[str] = None,
    uid: Optional[int] = None,
    run: Optional[Callable[[list[str]], tuple[int, str]]] = None,
) -> dict[str, Any]:
    """Probe the keep-alive service: ``{manager, unit, state}`` (SPEC §5.3 / §8.1)."""
    run = run or _run
    key = service_key(platform)
    if key is None:
        return {"manager": "none", "unit": None, "state": "unknown"}
    unit = SERVICE_UNITS[key]
    if key == "darwin":
        owner = uid if uid is not None else os.getuid()
        code, _ = run(["launchctl", "print", f"gui/{owner}/{unit}"])
        state = "running" if code == 0 else "stopped"
    else:
        code, out = run(["systemctl", "--user", "is-active", unit])
        state = "running" if code == 0 and out.strip() == "active" else "stopped"
    return {"manager": SERVICE_MANAGERS[key], "unit": unit, "state": state}


def run_service(
    action: str,
    *,
    paths: Optional[Mapping[str, Path]] = None,
    run: Optional[Callable[[list[str]], tuple[int, str]]] = None,
    timeout: float = 90.0,
) -> dict[str, Any]:
    """Spawn ``hermes-pilot service <action>`` and return its stdout (SPEC §8.1).

    ``restart`` is only ever reached from an explicit two-tap in the browser; this
    function adds no confirmation of its own because it is not a destructive
    operation (the bridge process is restarted, no data is removed).
    """
    if action not in SERVICE_ACTIONS:
        raise ValueError(f"Unknown service action: {action!r}")
    paths = paths or resolve_paths()
    meta = read_dashboard_meta(paths)
    if meta is None:
        raise MissingCli("Run `hermes-pilot init` first: the CLI location is not recorded")
    cli = Path(meta["cli"])
    if not cli.exists():
        raise MissingCli(f"CLI not found at {cli}")
    node = str(meta.get("node") or shutil.which("node") or "node")
    run = run or (lambda argv: _run(argv, timeout=timeout))
    code, output = run([node, str(cli), "service", action])
    return {"ok": code == 0, "action": action, "code": code, "stdout": output[-8000:]}


# --------------------------------------------------------------------------- bridge


def lan_ip(timeout: float = 0.3) -> Optional[str]:
    """Best-effort LAN address (no packet is sent: UDP connect only picks a route)."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.settimeout(timeout)
        # RFC 5737 TEST-NET-1 — documentation range, never a real peer.
        sock.connect(("192.0.2.1", 9))
        ip = sock.getsockname()[0]
    except OSError:
        return None
    finally:
        sock.close()
    return ip if ip and not ip.startswith("127.") else None


def bridge_request(
    base: str,
    path: str,
    token: Optional[str],
    *,
    method: str = "GET",
    body: Any = None,
    timeout: float = 4.0,
) -> Any:
    """Call the bridge with the app token server-side (GET/POST/PUT/DELETE).

    A 4xx/5xx answer is returned as its JSON envelope (the bridge always sends
    ``{ok:false, error, code?}``) so callers can pass the reason on; only a
    transport failure raises :class:`BridgeUnavailable`.
    """
    url = base.rstrip("/") + path
    if token:
        sep = "&" if "?" in url else "?"
        url = f"{url}{sep}{urllib.parse.urlencode({'t': token})}"
    headers = {"accept": "application/json"}
    if method.upper() not in ("GET", "HEAD"):
        # The bridge rejects a state-changing request without this marker
        # (`apps/bridge/src/auth.js` → `x-client` must be `mobile`), 401 otherwise.
        headers["x-client"] = "mobile"
    data: Optional[bytes] = None
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["content-type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - loopback only
            return json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            payload = json.loads(raw or "{}")
        except ValueError:
            payload = None
        if isinstance(payload, Mapping):
            out = dict(payload)
            out.setdefault("ok", False)
            return out
        return {"ok": False, "code": f"HTTP_{exc.code}", "error": f"bridge HTTP {exc.code}"}
    except urllib.error.URLError as exc:
        raise BridgeUnavailable(f"bridge {base} unreachable: {exc}") from exc
    except (OSError, ValueError) as exc:
        raise BridgeUnavailable(f"bridge {base} returned no JSON: {exc}") from exc


def bridge_get(base: str, path: str, token: Optional[str], timeout: float = 4.0) -> Any:
    """GET JSON from the bridge using the app token server-side."""
    return bridge_request(base, path, token, method="GET", timeout=timeout)


def bridge_base(paths: Mapping[str, Path], cfg: Optional[Mapping[str, Any]] = None) -> str:
    """Loopback base URL of the bridge on the configured port."""
    cfg = cfg if cfg is not None else read_config(paths["configPath"])
    return f"http://{BRIDGE_HOST}:{int(cfg.get('servicePort') or DEFAULT_PORT)}"


def local_capabilities(
    paths: Mapping[str, Path], *, which: Optional[Callable[[str], Optional[str]]] = None
) -> dict[str, Any]:
    """Fallback capability detection when the bridge is down (SPEC §5.3 shape)."""
    which = which or shutil.which
    key = service_key()
    home = Path(paths["home"])
    tailscale_app = home / "Applications" / "Tailscale.app" / "Contents" / "MacOS" / "Tailscale"
    has_tailscale = bool(which("tailscale")) or Path("/Applications/Tailscale.app/Contents/MacOS/Tailscale").exists() or tailscale_app.exists()
    has_hermes = bool(which("hermes")) or (home / ".hermes" / "hermes-agent" / ".hermes" / "bin" / "hermes").exists()
    key = service_key()
    unit = SERVICE_UNITS[key] if key else None
    return {
        "os": key or platform_module.system().lower(),
        "serviceManager": SERVICE_MANAGERS[key] if key else "none",
        "hasTailscale": has_tailscale,
        "hasHermesCli": has_hermes,
        "pilotServiceUnit": unit,
    }


# --------------------------------------------------------------------------- redaction


def redact(value: Any, token: Optional[str] = None) -> Any:
    """Strip the app token (and any long hex secret) from a payload.

    Defence in depth: the tab's endpoints are built to only return whitelisted
    keys, but a future field must not be able to leak the token by accident.
    """
    if isinstance(value, str):
        text = value.replace(token, "<redacted>") if token and token in value else value
        return HEX_SECRET.sub("<redacted>", text)
    if isinstance(value, Mapping):
        return {str(k): redact(v, token) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [redact(item, token) for item in value]
    return value


# --------------------------------------------------------------------------- payloads


def _urls(cfg: Mapping[str, Any], *, ip: Optional[str]) -> tuple[Optional[str], Optional[str]]:
    """``(lanUrl, tailscaleUrl)`` for the PWA links."""
    port = int(cfg.get("servicePort") or DEFAULT_PORT)
    lan = f"http://{ip}:{port}/" if ip else None
    dns = cfg.get("tailscaleDns")
    tailscale = None
    if dns:
        tls = cfg.get("tlsPort")
        tailscale = f"https://{dns}" + (f":{int(tls)}" if tls else "") + "/"
    return lan, tailscale


def build_status(
    paths: Optional[Mapping[str, Path]] = None,
    *,
    get: Optional[Callable[[str, str, Optional[str]], Any]] = None,
    service: Optional[Callable[..., dict[str, Any]]] = None,
    ip_lookup: Optional[Callable[[], Optional[str]]] = None,
) -> dict[str, Any]:
    """``GET /status`` payload — service, port, reachability, version, capabilities.

    Contains **no token**: everything is funnelled through :func:`redact`.
    """
    paths = paths or resolve_paths()
    get = get or bridge_get
    service = service or service_status
    ip_lookup = ip_lookup or lan_ip
    cfg = read_config(paths["configPath"])
    token = read_token(paths)
    base = f"http://{BRIDGE_HOST}:{int(cfg.get('servicePort') or DEFAULT_PORT)}"

    bridge: dict[str, Any] = {"reachable": False, "version": None}
    try:
        me = get(base, "/api/me", token)
        bridge = {"reachable": bool(isinstance(me, Mapping) and me.get("ok")), "version": (me or {}).get("version") if isinstance(me, Mapping) else None}
    except BridgeUnavailable:
        bridge = {"reachable": False, "version": None}

    capabilities = local_capabilities(paths)
    if bridge["reachable"]:
        try:
            remote = get(base, "/api/capabilities", token)
            if isinstance(remote, Mapping) and remote:
                capabilities = dict(remote)
        except BridgeUnavailable:
            pass

    lan_url, tailscale_url = _urls(cfg, ip=ip_lookup())
    payload = {
        "ok": True,
        "service": service(),
        "port": int(cfg.get("servicePort") or DEFAULT_PORT),
        "dataDir": str(paths["dataDir"]),
        "lanUrl": lan_url,
        "tailscaleUrl": tailscale_url,
        "bridge": bridge,
        "capabilities": capabilities,
    }
    return redact(payload, token)


def build_pairing(
    paths: Optional[Mapping[str, Path]] = None,
    *,
    get: Optional[Callable[[str, str, Optional[str]], Any]] = None,
) -> dict[str, Any]:
    """``GET /pairing`` — proxy the bridge's one-time code QR, whitelisted fields.

    The bridge mints an 8-character single-use code (never the 64-char token), so
    the QR stays coarse enough for a phone camera (SPEC §8.2).
    """
    paths = paths or resolve_paths()
    get = get or bridge_get
    cfg = read_config(paths["configPath"])
    token = read_token(paths)
    base = f"http://{BRIDGE_HOST}:{int(cfg.get('servicePort') or DEFAULT_PORT)}"
    raw = get(base, "/api/auth/pairing", token)
    if not isinstance(raw, Mapping):
        raise BridgeUnavailable("bridge returned an unexpected pairing payload")
    payload = {
        "ok": True,
        "qrPng": raw.get("qrPng"),
        "targets": raw.get("targets") if isinstance(raw.get("targets"), list) else [],
        "expiresAt": raw.get("expiresAt"),
        "port": raw.get("port") or int(cfg.get("servicePort") or DEFAULT_PORT),
        "tlsPort": raw.get("tlsPort"),
        "tailscale": bool(raw.get("tailscale")),
    }
    return redact(payload, token)


# --------------------------------------------------------------- repos (G3)
#
# `scanDirs` used to live only in `config.json`, while the bridge scanned
# `repos.json` — the audit's G3. One file is now the source of truth and every
# write goes through the bridge first, falling back to an atomic file write when
# the bridge is down.


def normalize_path(value: str, home: Optional[Path] = None) -> str:
    """Comparison key for a path: expanded, absolute, lower-cased, no trailing slash."""
    home = Path(home) if home is not None else Path.home()
    absolute = Path(expand_path(str(value or ""), home))
    text = str(absolute).lower()
    return text[:-1] if len(text) > 1 and text.endswith("/") else text


def repo_id_from_path(value: str) -> str:
    """Board-safe id from a path (`[a-z0-9._-]` only), same rule as the bridge."""
    import posixpath

    base = posixpath.basename(str(value or "").rstrip("/")) or "repo"
    slug = re.sub(r"[^a-z0-9._-]+", "-", base.lower()).strip("-")[:64]
    return slug or "repo"


def _real_basename(abs_path: str) -> str:
    """Actual directory name casing on disk (falls back to basename when absent)."""
    p = Path(abs_path)
    try:
        entries = os.listdir(str(p.parent))
    except OSError:
        return p.name
    if p.name in entries:
        return p.name
    lower = p.name.lower()
    for name in entries:
        if name.lower() == lower:
            return name
    return p.name


def _dedupe_scan_dirs(dirs: Any, home: Optional[Path] = None) -> list[str]:
    """Collapse case-insensitive same-inode duplicates (e.g. ``~/Projects`` & ``~/projects``)."""
    home = Path(home) if home is not None else Path.home()
    out: list[str] = []
    seen: dict[tuple[Any, ...], int] = {}
    for raw in dirs or []:
        text = str(raw).strip() if isinstance(raw, str) else ""
        if not text:
            continue
        expanded = expand_path(text, home)
        try:
            st = os.stat(expanded)
            key: tuple[Any, ...] = ("ino", st.st_dev, st.st_ino)
        except OSError:
            key = ("raw", text)
        if key not in seen:
            seen[key] = len(out)
            out.append(text)
            continue
        idx = seen[key]
        prev = out[idx]
        text_tilde = text.startswith("~/")
        prev_tilde = prev.startswith("~/")
        if text_tilde and not prev_tilde:
            out[idx] = text
        elif text_tilde == prev_tilde:
            real_base = _real_basename(expanded)
            if Path(expanded).name == real_base and Path(expand_path(prev, home)).name != real_base:
                out[idx] = text
    return out


def default_repos_config(home: Optional[Path] = None) -> dict[str, Any]:
    """Empty repository config whose ``scanDirs`` are the ones that exist here."""
    home = Path(home) if home is not None else Path.home()
    dirs = _dedupe_scan_dirs([d for d in DEFAULT_SCAN_DIRS if Path(expand_path(d, home)).is_dir()], home)
    return {"scanDirs": dirs, "pinned": [], "hidden": [], "custom": []}


def normalize_repos_config(raw: Any, home: Optional[Path] = None) -> dict[str, Any]:
    """Sanitise a ``repos.json`` body (garbage entries are dropped, never fatal)."""
    home = Path(home) if home is not None else Path.home()
    base = default_repos_config(home)
    if not isinstance(raw, Mapping):
        return base

    def strings(value: Any) -> list[str]:
        if not isinstance(value, list):
            return []
        out: list[str] = []
        for item in value:
            text = str(item).strip() if isinstance(item, str) else ""
            if text and text not in out:
                out.append(text)
        return out

    custom: list[dict[str, str]] = []
    if isinstance(raw.get("custom"), list):
        for entry in raw["custom"]:
            if not isinstance(entry, Mapping):
                continue
            absolute = expand_path(str(entry.get("path") or ""), home)
            if not absolute.startswith("/"):
                continue
            custom.append({"id": str(entry.get("id") or "").strip() or repo_id_from_path(absolute), "label": str(entry.get("label") or "").strip() or Path(absolute).name, "path": absolute})
    scan_dirs = _dedupe_scan_dirs(strings(raw.get("scanDirs")), home)
    return {"scanDirs": scan_dirs or base["scanDirs"], "pinned": strings(raw.get("pinned")), "hidden": strings(raw.get("hidden")), "custom": custom}


def read_repos_config(paths: Mapping[str, Path]) -> Optional[dict[str, Any]]:
    """Read ``repos.json``; ``None`` when the file is absent (not yet written)."""
    try:
        raw = json.loads(Path(paths["reposPath"]).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return normalize_repos_config(raw, Path(paths["home"]))


def _write_json_atomic(path: Path | str, payload: Any, home: Optional[Path] = None) -> dict[str, Any]:
    """tmp → rename, 0600, no leftover temp file."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    body = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    fd, tmp_name = tempfile.mkstemp(dir=str(target.parent), prefix=f".{target.name}-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(body)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp_name, 0o600)
        os.replace(tmp_name, target)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise
    return payload


def write_repos_config_atomic(paths: Mapping[str, Path], data: Mapping[str, Any]) -> dict[str, Any]:
    """Write ``repos.json`` atomically (0600) and return the normalised body."""
    normalized = normalize_repos_config(data, Path(paths["home"]))
    _write_json_atomic(paths["reposPath"], normalized)
    return normalized


def scan_git_dirs(scan_dirs: Any, home: Optional[Path] = None) -> list[dict[str, str]]:
    """One level under each scan dir, `.git` only — the bridge's rule, mirrored."""
    home = Path(home) if home is not None else Path.home()
    found: list[dict[str, str]] = []
    seen: set[str] = set()
    for raw in scan_dirs or []:
        parent = Path(expand_path(str(raw or ""), home))
        if not parent.is_absolute():
            continue
        try:
            entries = sorted(parent.iterdir())
        except OSError:
            continue
        for entry in entries:
            if not entry.is_dir() or entry.name.startswith("."):
                continue
            if not (entry / ".git").exists():
                continue
            key = normalize_path(str(entry), home)
            if key in seen:
                continue
            seen.add(key)
            found.append({"id": repo_id_from_path(str(entry)), "label": entry.name, "path": str(entry), "source": "scan"})
    return found


def local_repos(config: Mapping[str, Any], home: Optional[Path] = None) -> list[dict[str, Any]]:
    """Repository rows from ``repos.json`` alone (bridge down).

    The bridge also merges board workdirs and session cwds; offline this is the
    subset the file itself knows, which is what the card needs to edit.
    """
    home = Path(home) if home is not None else Path.home()
    hidden = {normalize_path(p, home) for p in config.get("hidden") or []}
    pinned = [str(p) for p in config.get("pinned") or []]
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    candidates = list(config.get("custom") or []) + scan_git_dirs(config.get("scanDirs"), home)
    for entry in candidates:
        absolute = expand_path(str(entry.get("path") or ""), home)
        key = normalize_path(absolute, home)
        if not absolute.startswith("/") or key in seen or key in hidden or not (Path(absolute) / ".git").exists():
            continue
        seen.add(key)
        if key == normalize_path(str(home), home):
            continue
        rid = str(entry.get("id") or repo_id_from_path(absolute))
        rows.append(
            {
                "id": rid,
                "label": str(entry.get("label") or Path(absolute).name),
                "path": absolute,
                "source": str(entry.get("source") or "custom"),
                "pinned": rid in pinned or absolute in pinned,
                "boards": [],
            }
        )
    rows.sort(key=lambda r: (not r["pinned"], r["label"].lower()))
    return rows


def build_config(paths: Optional[Mapping[str, Path]] = None) -> dict[str, Any]:
    """``GET /config`` — ``repos.json``'s ``scanDirs`` win over ``config.json``.

    That inversion is the whole point of G3: the PWA edits ``repos.json`` and the
    tab must not show a stale value from the older ``config.json`` field.
    """
    paths = paths or resolve_paths()
    home = Path(paths["home"])
    cfg = read_config(paths["configPath"])
    repos = read_repos_config(paths)
    source = "config.json"
    if repos and repos.get("scanDirs"):
        cfg["scanDirs"] = list(repos["scanDirs"])
        source = "repos.json"
    cfg["scanDirs"] = _dedupe_scan_dirs(cfg.get("scanDirs"), home)
    return {"ok": True, "config": cfg, "dataDir": str(paths["dataDir"]), "scanDirsSource": source, "reposPath": shorten_path(str(paths["reposPath"]), home)}


def sync_scan_dirs(
    paths: Optional[Mapping[str, Path]] = None,
    scan_dirs: Any = None,
    *,
    request: Optional[Callable[..., Any]] = None,
) -> dict[str, Any]:
    """Write ``scanDirs`` to the bridge **and** ``repos.json`` (G3).

    The bridge is tried first because its writer also invalidates the 30 s scan
    cache, so ``GET /api/repos`` reflects the change on the next request. When it
    is not running the file is written directly — the same atomic tmp→rename —
    and the next bridge start picks it up.
    """
    paths = paths or resolve_paths()
    home = Path(paths["home"])
    request = request or bridge_request
    dirs = _dedupe_scan_dirs(scan_dirs, home)
    token = read_token(paths)
    base = bridge_base(paths)
    bridge: dict[str, Any] = {"attempted": True, "ok": False, "error": None}
    try:
        answer = request(base, "/api/repos", token, method="POST", body={"scanDirs": dirs})
        if isinstance(answer, Mapping):
            bridge["ok"] = bool(answer.get("ok", True))
            if not bridge["ok"]:
                bridge["error"] = str(answer.get("error") or "the bridge rejected scanDirs")
            if isinstance(answer.get("scanDirs"), list) and answer["scanDirs"]:
                dirs = _dedupe_scan_dirs(answer["scanDirs"], home)
    except BridgeUnavailable as exc:
        bridge["error"] = str(exc)
    config = read_repos_config(paths) or default_repos_config(home)
    config["scanDirs"] = dirs or config["scanDirs"]
    write_repos_config_atomic(paths, config)
    return {"scanDirs": list(config["scanDirs"]), "source": "bridge" if bridge["ok"] else "file", "bridge": bridge}


def build_repos(
    paths: Optional[Mapping[str, Path]] = None,
    *,
    request: Optional[Callable[..., Any]] = None,
) -> dict[str, Any]:
    """``GET /repos`` — the bridge's merged list, or the file's own rows offline."""
    paths = paths or resolve_paths()
    request = request or bridge_request
    token = read_token(paths)
    base = bridge_base(paths)
    payload: dict[str, Any]
    try:
        raw = request(base, "/api/repos", token, method="GET")
        if not isinstance(raw, Mapping) or not isinstance(raw.get("repos"), list):
            raise BridgeUnavailable("bridge returned an unexpected repos payload")
        payload = {
            "ok": True,
            "source": "bridge",
            "repos": raw["repos"],
            "scanDirs": raw.get("scanDirs") if isinstance(raw.get("scanDirs"), list) else [],
        }
    except BridgeUnavailable as exc:
        home = Path(paths["home"])
        config = read_repos_config(paths) or default_repos_config(home)
        payload = {
            "ok": True,
            "source": "file",
            "repos": local_repos(config, home),
            "scanDirs": config["scanDirs"],
            "notice": str(exc),
        }
    # The hidden list lives only in repos.json (the bridge filters it out of the
    # merged list), so the card needs it to offer "unhide".
    config = read_repos_config(paths) or default_repos_config(Path(paths["home"]))
    payload["config"] = {
        "hidden": [shorten_path(p, Path(paths["home"])) for p in config.get("hidden") or []],
        "pinned": list(config.get("pinned") or []),
        "custom": [{"id": c["id"], "label": c["label"], "path": shorten_path(c["path"], Path(paths["home"]))} for c in config.get("custom") or []],
    }
    return redact(payload, token)


def _find_repo(config: Mapping[str, Any], home: Path, repo_id: str) -> Optional[dict[str, Any]]:
    """Locate a repo row by id — including one currently hidden (unhide needs it)."""
    for row in local_repos(config, home):
        if row["id"] == repo_id:
            return row
    for entry in config.get("custom") or []:
        if str(entry.get("id")) == repo_id:
            return dict(entry)
    for raw in config.get("hidden") or []:
        absolute = expand_path(str(raw), home)
        if repo_id_from_path(absolute) == repo_id or normalize_path(absolute, home) == normalize_path(repo_id, home):
            return {"id": repo_id, "label": Path(absolute).name, "path": absolute}
    return None


def repos_action(
    paths: Optional[Mapping[str, Path]] = None,
    payload: Any = None,
    *,
    request: Optional[Callable[..., Any]] = None,
) -> dict[str, Any]:
    """``POST /repos`` — ``add|hide|unhide|pin|unpin|createBoard``.

    Adding and hiding go through the bridge so its audit trail records them (and
    its validation runs); unhide/pin/unpin only exist in ``repos.json``, so those
    are written here and the bridge cache is invalidated with a re-scan.
    """
    paths = paths or resolve_paths()
    request = request or bridge_request
    body: Mapping[str, Any] = payload if isinstance(payload, Mapping) else {}
    action = str(body.get("action") or "").strip()
    if action not in REPO_ACTIONS:
        return {"ok": False, "code": "invalid_action", "error": f"action must be one of {', '.join(REPO_ACTIONS)}"}

    home = Path(paths["home"])
    token = read_token(paths)
    base = bridge_base(paths)
    repo_id = str(body.get("id") or "").strip()
    config = read_repos_config(paths) or default_repos_config(home)
    bridge_used = False
    note: Optional[str] = None

    def touch_bridge() -> None:
        """Invalidate the bridge's 30 s scan cache after a file-only edit."""
        try:
            request(base, "/api/repos/scan", token, method="POST")
        except BridgeUnavailable:
            pass

    if action == "add":
        raw = str(body.get("path") or "").strip()
        if not raw:
            return {"ok": False, "code": "path_required", "error": "A path is required"}
        absolute = expand_path(raw, home)
        if normalize_path(absolute, home) == normalize_path(str(home), home):
            return {"ok": False, "code": "home_directory", "error": "The home directory itself cannot be a repository"}
        if not Path(absolute).is_dir():
            return {"ok": False, "code": "not_a_directory", "error": f"{raw} is not a directory"}
        if not (Path(absolute) / ".git").exists():
            return {"ok": False, "code": "not_git_repo", "error": f"{raw} is not a git repository"}
        label = str(body.get("label") or "").strip() or Path(absolute).name
        try:
            answer = request(base, "/api/repos", token, method="POST", body={"path": absolute, "label": label})
            bridge_used = True
            if not answer.get("ok", True):
                return {"ok": False, "code": "bridge_rejected", "error": str(answer.get("error") or "the bridge rejected the path")}
        except BridgeUnavailable as exc:
            note = str(exc)
            key = normalize_path(absolute, home)
            config["custom"] = [c for c in config.get("custom") or [] if normalize_path(c.get("path", ""), home) != key]
            config["custom"].append({"id": repo_id_from_path(absolute), "label": label, "path": absolute})
            config["hidden"] = [p for p in config.get("hidden") or [] if normalize_path(p, home) != key]
            config["pinned"] = [p for p in config.get("pinned") or [] if normalize_path(p, home) != key]
            write_repos_config_atomic(paths, config)
    elif action == "createBoard":
        if not repo_id:
            return {"ok": False, "code": "id_required", "error": "A repository id is required"}
        try:
            answer = request(base, f"/api/repos/{urllib.parse.quote(repo_id)}/board", token, method="POST")
            bridge_used = True
        except BridgeUnavailable:
            return {"ok": False, "code": "bridge_required", "error": "The bridge must be running to create a board"}
        if not answer.get("ok", True):
            return {"ok": False, "code": "board_failed", "error": str(answer.get("error") or "the board could not be created")}
    else:  # hide / unhide / pin / unpin
        if not repo_id:
            return {"ok": False, "code": "id_required", "error": "A repository id is required"}
        row = _find_repo(config, home, repo_id)
        if row is None:
            return {"ok": False, "code": "unknown_repo", "error": f"unknown repository: {repo_id}"}
        key = normalize_path(str(row["path"]), home)
        pinned = [str(p) for p in config.get("pinned") or []]
        if action == "hide":
            try:
                answer = request(base, f"/api/repos/{urllib.parse.quote(repo_id)}", token, method="DELETE")
                bridge_used = bool(answer.get("ok", True))
                if not bridge_used:
                    return {"ok": False, "code": "bridge_rejected", "error": str(answer.get("error") or "hide failed")}
            except BridgeUnavailable as exc:
                note = str(exc)
                is_custom = any(normalize_path(c.get("path", ""), home) == key for c in config.get("custom") or [])
                if is_custom:
                    config["custom"] = [c for c in config.get("custom") or [] if normalize_path(c.get("path", ""), home) != key]
                elif key not in {normalize_path(p, home) for p in config.get("hidden") or []}:
                    config["hidden"] = list(config.get("hidden") or []) + [key]
        elif action == "unhide":
            config["hidden"] = [p for p in config.get("hidden") or [] if normalize_path(p, home) != key]
        elif action == "pin":
            config["pinned"] = [repo_id] + [p for p in pinned if p not in (repo_id, key)]
        else:  # unpin
            config["pinned"] = [p for p in pinned if p not in (repo_id, key) and normalize_path(p, home) != key]
        if not bridge_used:
            write_repos_config_atomic(paths, config)
            touch_bridge()

    fresh = build_repos(paths, request=request)
    out: dict[str, Any] = {
        "ok": True,
        "action": action,
        "source": fresh.get("source"),
        "repos": fresh.get("repos", []),
        "scanDirs": fresh.get("scanDirs", []),
    }
    if note:
        out["notice"] = note
    return redact(out, token)


# ------------------------------------------------------ pipeline & architect


def build_pipeline(
    paths: Optional[Mapping[str, Path]] = None,
    *,
    board: Optional[str] = None,
    request: Optional[Callable[..., Any]] = None,
) -> dict[str, Any]:
    """``GET /pipeline`` — Architect runner, SOUL/skill status, unfiled specs.

    Everything comes from the bridge; when it is down the payload still renders
    (``source: "offline"``) so the card explains itself instead of going blank.
    Only whitelisted keys leave this function, and ``redact`` runs last.
    """
    paths = paths or resolve_paths()
    request = request or bridge_request
    token = read_token(paths)
    base = bridge_base(paths)
    query = f"?board={urllib.parse.quote(str(board))}" if board else ""

    payload: dict[str, Any] = {
        "ok": True,
        "source": "bridge",
        "board": board or None,
        # ランナーは Hermes Native 固定（外部 CLI の子プロセス起動は行わない）
        "runner": "hermes",
        "pipeline": None,
        "jobs": [],
        "pending": [],
        "specReady": [],
    }

    try:
        # GET はブリッジの生死判定だけに使う（ランナー切替は廃止済み）
        request(base, "/api/architect/config", token, method="GET")
    except BridgeUnavailable as exc:
        payload["source"] = "offline"
        payload["notice"] = str(exc)

    try:
        status = request(base, "/api/pipeline/status", token, method="GET")
        if isinstance(status, Mapping) and status.get("ok"):
            payload["pipeline"] = {
                "soul": status.get("soul"),
                "hermes": status.get("hermes"),
                "antigravity": [
                    {"id": t.get("id"), "available": bool(t.get("available")), "present": t.get("present") or [], "missing": t.get("missing") or []}
                    for t in (status.get("antigravity") or [])
                    if isinstance(t, Mapping)
                ],
            }
    except BridgeUnavailable:
        pass

    try:
        jobs = request(base, "/api/architect/jobs" + query, token, method="GET")
        if isinstance(jobs, Mapping) and jobs.get("ok"):
            payload["jobs"] = [
                {
                    "id": j.get("id"),
                    "status": j.get("status"),
                    "runner": j.get("runner"),
                    "autoStart": bool(j.get("autoStart")),
                    "spec": j.get("spec"),
                    "createdAt": j.get("createdAt"),
                }
                for j in (jobs.get("jobs") or [])[:6]
                if isinstance(j, Mapping)
            ]
            payload["jobCount"] = len(jobs.get("jobs") or [])
            payload["pending"] = [
                {"path": p.get("path"), "title": p.get("title"), "pendingCount": p.get("pendingCount")}
                for p in (jobs.get("pending") or [])[:6]
                if isinstance(p, Mapping)
            ]
            payload["specReady"] = [
                {"spec": s.get("spec"), "title": s.get("title"), "batchCount": s.get("batchCount"), "launched": bool(s.get("launched"))}
                for s in (jobs.get("specReady") or [])[:6]
                if isinstance(s, Mapping)
            ]
    except BridgeUnavailable:
        pass

    return redact(payload, token)


def pipeline_action(
    paths: Optional[Mapping[str, Path]] = None,
    payload: Any = None,
    *,
    request: Optional[Callable[..., Any]] = None,
) -> dict[str, Any]:
    """``POST /pipeline`` — ``{action: "optimize"} | {action: "setRunner", runner}``.

    Both run **on the bridge**, so the audit trail records them. The runner is
    fixed to ``hermes`` (Hermes Native); anything else is rejected here and by
    the bridge, and passed back verbatim — the tab never invents success.
    """
    paths = paths or resolve_paths()
    request = request or bridge_request
    body: Mapping[str, Any] = payload if isinstance(payload, Mapping) else {}
    action = str(body.get("action") or "").strip()
    token = read_token(paths)
    base = bridge_base(paths)

    if action == "optimize":
        try:
            answer = request(base, "/api/pipeline/optimize", token, method="POST", body={})
        except BridgeUnavailable as exc:
            return {"ok": False, "code": "bridge_unreachable", "error": str(exc)}
        out: dict[str, Any] = dict(answer) if isinstance(answer, Mapping) else {"ok": False}
        out["action"] = "optimize"
        return redact(out, token)

    if action == "setRunner":
        runner = str(body.get("runner") or "").strip()
        if runner != "hermes":
            return {"ok": False, "code": "invalid_runner", "error": "runner must be hermes"}
        try:
            answer = request(base, "/api/architect/config", token, method="PUT", body={"runner": runner})
        except BridgeUnavailable as exc:
            return {"ok": False, "code": "bridge_unreachable", "error": str(exc)}
        out: dict[str, Any] = dict(answer) if isinstance(answer, Mapping) else {"ok": False}
        out["action"] = "setRunner"
        return redact(out, token)

    return {"ok": False, "code": "invalid_action", "error": "action must be one of optimize, setRunner"}


# ----------------------------------------------------------------- snippets


def snippet_store_path(paths: Mapping[str, Path], kind: str) -> Path:
    """File behind each snippet kind (`snippets.json` / `term-snippets.json`)."""
    return Path(paths["termSnippetsPath"] if kind == "term" else paths["snippetsPath"])


def normalize_snippet_store(
    raw: Any,
    *,
    kind: str = "chat",
    previous: Optional[Mapping[str, Any]] = None,
    reset: bool = False,
) -> dict[str, Any]:
    """Sanitise a snippet store to the bridge's version-2 shape.

    ``overrides`` may only carry booleans (``hot`` / ``hidden``) for known-ish ids;
    ``custom`` entries need a label and text, get a ``c-`` id, and keep ``run``
    for terminal snippets.
    """
    src: Mapping[str, Any] = raw if isinstance(raw, Mapping) else {}
    if reset:
        return {"version": 2, "overrides": {}, "custom": []}
    prev = previous if isinstance(previous, Mapping) else {}
    overrides: dict[str, dict[str, bool]] = {}
    source_overrides = src.get("overrides", prev.get("overrides", {}))
    if isinstance(source_overrides, Mapping):
        for key, value in source_overrides.items():
            name = str(key or "").strip()
            if not name or not isinstance(value, Mapping):
                continue
            override: dict[str, bool] = {}
            if isinstance(value.get("hot"), bool):
                override["hot"] = value["hot"]
            if isinstance(value.get("hidden"), bool):
                override["hidden"] = value["hidden"]
            if override:
                overrides[name] = override
    custom: list[dict[str, Any]] = []
    source_custom = src.get("custom", prev.get("custom", []))
    seen: set[str] = set()
    if isinstance(source_custom, list):
        for item in source_custom[:CUSTOM_MAX]:
            if not isinstance(item, Mapping):
                continue
            label = str(item.get("label") or "").strip()[:LABEL_MAX]
            text = str(item.get("text") or "").strip()[:TEXT_MAX]
            if not label or not text:
                continue
            given = str(item.get("id") or "").strip()
            sid = given if CUSTOM_ID_RE.match(given) and given not in seen else f"c-{len(seen) + 1:x}"
            while sid in seen:
                sid = f"c-{len(seen) + 1:x}{len(seen):x}"
            seen.add(sid)
            entry: dict[str, Any] = {"id": sid, "label": label, "text": text, "hot": bool(item.get("hot")), "custom": True}
            if item.get("hidden") is True:
                entry["hidden"] = True
            if kind == "term":
                entry["run"] = item.get("run") is not False
                note = str(item.get("note") or "").strip()[:TEXT_MAX]
                if note:
                    entry["note"] = note
            custom.append(entry)
    return {"version": 2, "overrides": overrides, "custom": custom}


def _snippet_payload(raw: Mapping[str, Any], *, kind: str, lang: str, source: str) -> dict[str, Any]:
    """Whitelist the bridge's snippet payload so no field can smuggle a secret."""
    return {"ok": True, "source": source, "kind": kind, "lang": lang, "snippets": raw.get("snippets") if isinstance(raw.get("snippets"), list) else [], "allSnippets": raw.get("allSnippets") if isinstance(raw.get("allSnippets"), list) else [], "overrides": raw.get("overrides") if isinstance(raw.get("overrides"), Mapping) else {}, "custom": raw.get("custom") if isinstance(raw.get("custom"), list) else [], "customMax": raw.get("customMax") or CUSTOM_MAX, "hotLimit": raw.get("hotLimit") or HOT_LIMIT}


def _snippet_route(kind: str, lang: str, *, method: str = "GET") -> str:
    suffix = f"?lang={urllib.parse.quote(str(lang or 'en'))}"
    return f"/api/snippets/term{suffix}" if kind == "term" else f"/api/snippets{suffix}"


def _local_snippet_payload(paths: Mapping[str, Path], kind: str, lang: str, note: Optional[str] = None) -> dict[str, Any]:
    """Bridge-down fallback: the store as saved, no built-in labels to render."""
    file = snippet_store_path(paths, kind)
    try:
        raw = json.loads(file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raw = {}
    store = normalize_snippet_store(raw, kind=kind)
    payload: dict[str, Any] = {"ok": True, "source": "file", "kind": kind, "lang": lang, "snippets": [], "allSnippets": [], "overrides": store["overrides"], "custom": store["custom"], "customMax": CUSTOM_MAX, "hotLimit": HOT_LIMIT}
    if note:
        payload["notice"] = note
    return payload


def build_snippets(
    paths: Optional[Mapping[str, Path]] = None,
    kind: str = "chat",
    lang: str = "en",
    *,
    request: Optional[Callable[..., Any]] = None,
) -> dict[str, Any]:
    """``GET /snippets?kind=chat|term&lang=en|ja`` — bridge first, file offline."""
    if kind not in SNIPPET_KINDS:
        raise ValueError(f"kind must be one of {', '.join(SNIPPET_KINDS)}")
    paths = paths or resolve_paths()
    request = request or bridge_request
    token = read_token(paths)
    try:
        raw = request(bridge_base(paths), _snippet_route(kind, lang), token, method="GET")
        if not isinstance(raw, Mapping):
            raise BridgeUnavailable("bridge returned an unexpected snippets payload")
        payload = _snippet_payload(raw, kind=kind, lang=lang, source="bridge")
    except BridgeUnavailable as exc:
        payload = _local_snippet_payload(paths, kind, lang, str(exc))
    return redact(payload, token)


def save_snippets(
    paths: Optional[Mapping[str, Path]] = None,
    kind: str = "chat",
    lang: str = "en",
    payload: Any = None,
    *,
    request: Optional[Callable[..., Any]] = None,
) -> dict[str, Any]:
    """``PUT /snippets`` — bridge first (it audits), atomic file write offline."""
    if kind not in SNIPPET_KINDS:
        raise ValueError(f"kind must be one of {', '.join(SNIPPET_KINDS)}")
    paths = paths or resolve_paths()
    request = request or bridge_request
    token = read_token(paths)
    body: Mapping[str, Any] = payload if isinstance(payload, Mapping) else {}
    try:
        raw = request(bridge_base(paths), _snippet_route(kind, lang), token, method="PUT", body=dict(body))
        if isinstance(raw, Mapping) and raw.get("ok", True) is not False and isinstance(raw.get("custom"), list):
            return redact(_snippet_payload(raw, kind=kind, lang=lang, source="bridge"), token)
    except BridgeUnavailable:
        pass
    file = snippet_store_path(paths, kind)
    try:
        current = json.loads(file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        current = {}
    store = normalize_snippet_store(body, kind=kind, previous=current, reset=body.get("reset") is True)
    _write_json_atomic(file, store)
    return redact(_local_snippet_payload(paths, kind, lang), token)


# -------------------------------------------------------------------- logs


def log_path(paths: Mapping[str, Path], name: str) -> Path:
    """Resolve a whitelisted log name to a file (no path from the browser)."""
    if name == "audit":
        return Path(paths["auditPath"])
    candidates = LOG_FILES[name]
    for filename in candidates:
        candidate = Path(paths["logDir"]) / filename
        if candidate.exists():
            return candidate
    return Path(paths["logDir"]) / candidates[0]


def read_tail_text(file_path: Path | str, max_bytes: int = LOG_READ_BYTES) -> str:
    """Last *max_bytes* of a text file, dropping the partial first line."""
    target = Path(file_path)
    stat = target.stat()
    if stat.st_size <= max_bytes:
        return target.read_text(encoding="utf-8", errors="replace")
    with target.open("rb") as fh:
        fh.seek(stat.st_size - max_bytes)
        raw = fh.read(max_bytes).decode("utf-8", "replace")
    newline = raw.find("\n")
    return raw[newline + 1 :] if newline >= 0 else raw


#: Keys the audit card renders as its own row instead of `key=value` detail.
AUDIT_ROW_KEYS = ("at", "kind", "ok")


def audit_entries(lines: Iterable[str]) -> list[dict[str, Any]]:
    """``audit.jsonl`` tail → newest-first rows the dashboard draws as a list.

    The JSON is parsed here rather than in the browser so a partially written
    line still renders (as ``detail``) and every field goes through the same
    :func:`redact` pass as the raw text — ``build_logs`` redacts the whole
    payload, ``entries`` included (SPEC V3 §3.5).
    """
    out: list[dict[str, Any]] = []
    for line in reversed(list(lines or [])):
        try:
            parsed = json.loads(line)
        except (TypeError, ValueError):
            parsed = None
        if not isinstance(parsed, dict):
            out.append({"at": "", "kind": "", "ok": None, "detail": str(line)})
            continue
        detail: list[str] = []
        for key, value in parsed.items():
            if key in AUDIT_ROW_KEYS or value is None or value == "":
                continue
            if isinstance(value, (dict, list)):
                value = json.dumps(value, ensure_ascii=False)
            detail.append(f"{key}={value}")
        at, kind, ok = parsed.get("at"), parsed.get("kind"), parsed.get("ok")
        out.append({"at": at if isinstance(at, str) else "", "kind": kind if isinstance(kind, str) else "", "ok": ok if isinstance(ok, bool) else None, "detail": " · ".join(detail)})
    return out


def build_logs(
    paths: Optional[Mapping[str, Path]] = None,
    name: str = "gateway",
    lines: int = 120,
    *,
    read: Optional[Callable[[Path | str], str]] = None,
) -> dict[str, Any]:
    """``GET /logs`` — the tail of one log, always through :func:`redact`.

    The token is the bridge's own credential; a gateway log line can contain a
    ``?t=<token>`` URL, so nothing here is returned unredacted.
    """
    if name not in LOG_FILES:
        raise ValueError(f"file must be one of {', '.join(LOG_FILES)}")
    paths = paths or resolve_paths()
    read = read or read_tail_text
    try:
        limit = int(lines)
    except (TypeError, ValueError):
        limit = 120
    limit = max(1, min(limit, LOG_LINES_MAX))
    path = log_path(paths, name)
    missing = False
    try:
        text = read(path)
    except OSError:
        text = ""
        missing = True
    tail = [line for line in text.split("\n") if line] if text else []
    tail = tail[-limit:]
    payload = {"ok": True, "file": name, "lines": [LOG_QUERY_SECRET.sub(r"\1<redacted>", line) for line in tail], "shown": len(tail), "missing": missing, "path": shorten_path(str(path), Path(paths["home"]))}
    if name == "audit":
        # Structured rows for the dashboard's accordion list: parsed here so the
        # browser never has to guess, and redacted by the same pass below.
        payload["entries"] = audit_entries(tail)
    return redact(payload, read_token(paths))
