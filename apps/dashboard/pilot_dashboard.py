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
from typing import Any, Callable, Mapping, Optional

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
    return {
        "home": home,
        "hermesHome": hh,
        "dataDir": data_dir,
        "configPath": data_dir / "config.json",
        "tokenPath": data_dir / "token",
        # Written by `hermes-pilot init`: where the CLI lives, so `service` can spawn it.
        "dashboardMetaPath": data_dir / "dashboard.json",
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
    return {
        "lang": "en",
        "scanDirs": list(DEFAULT_SCAN_DIRS),
        "tlsPort": None,
        "tailscaleDns": None,
        "servicePort": port,
    }


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
        elif len(cleaned) > 20:
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


def bridge_get(base: str, path: str, token: Optional[str], timeout: float = 4.0) -> Any:
    """GET JSON from the bridge using the app token server-side."""
    url = base.rstrip("/") + path
    if token:
        sep = "&" if "?" in url else "?"
        url = f"{url}{sep}{urllib.parse.urlencode({'t': token})}"
    request = urllib.request.Request(url, headers={"accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - loopback only
            return json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.URLError as exc:
        raise BridgeUnavailable(f"bridge {base} unreachable: {exc}") from exc
    except (OSError, ValueError) as exc:
        raise BridgeUnavailable(f"bridge {base} returned no JSON: {exc}") from exc


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
