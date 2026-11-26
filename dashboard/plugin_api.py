"""FastAPI routes for the Hermes Pilot tab on the standard dashboard.

The dashboard imports this file from disk without adding ``dashboard/`` to
``sys.path`` (``hermes_cli/web_server_dashboard.py`` → ``import_user_code``), so
the sibling logic module is loaded explicitly under a unique name instead of a
bare ``import pilot_dashboard``. That keeps a generic module name from colliding
with anything else in the dashboard process.

All routes are plain ``def`` so FastAPI runs them in its threadpool (the bridge
calls are blocking ``urllib``). Paths are relative: the host mounts this router
at ``/api/plugins/hermes-pilot``.

Response contract
-----------------
``GET /status``    → ``{ok, service:{manager,unit,state}, port, dataDir, lanUrl,
                       tailscaleUrl, bridge:{reachable,version}, capabilities}``
``GET /pairing``   → ``{ok, qrPng, targets, expiresAt, port, tlsPort, tailscale}``
``GET /config``    → ``{ok, config, dataDir, scanDirsSource, reposPath}``
``PUT /config``    → ``{ok, config, sync?}`` or ``400 {ok:false, code:"INVALID_CONFIG",
                       errors:{field:code}, messages:{field:text}}``
``POST /service/{install|restart|status}`` → ``{ok, action, code, stdout}``
``GET /repos``     → ``{ok, source:"bridge"|"file", repos, scanDirs}``
``POST /repos``    → ``{ok, action, repos, scanDirs}`` (``add|hide|unhide|pin|unpin|createBoard``)
``GET /snippets?kind=chat|term&lang=en|ja`` → ``{ok, source, kind, lang, allSnippets, custom, ...}``
``PUT /snippets?kind=…&lang=…``             → same shape, after saving
``GET /logs?file=gateway|errors|pilot|audit&lines=120`` → ``{ok, file, lines, shown, missing, path}``

The app token is never part of any response — see ``pilot_dashboard.redact``.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Body, Query
from fastapi.responses import JSONResponse

_DIR = Path(__file__).resolve().parent
_LOGIC_MODULE = "hermes_dashboard_hermes_pilot_logic"


def _load_logic() -> Any:
    """Load ``pilot_dashboard.py`` as a uniquely named module (idempotent)."""
    existing = sys.modules.get(_LOGIC_MODULE)
    if existing is not None:
        return existing
    spec = importlib.util.spec_from_file_location(_LOGIC_MODULE, _DIR / "pilot_dashboard.py")
    if spec is None or spec.loader is None:  # pragma: no cover - defensive
        raise ImportError(f"hermes-pilot: cannot load logic from {_DIR}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[_LOGIC_MODULE] = module
    try:
        spec.loader.exec_module(module)
    except Exception:  # pragma: no cover - keep sys.modules clean on failure
        sys.modules.pop(_LOGIC_MODULE, None)
        raise
    return module


logic = _load_logic()

VERSION = "0.3.0"
router = APIRouter()


def fail(status: int, code: str, message: str, detail: Any = None) -> JSONResponse:
    """Machine-readable error envelope (SPEC §6.3: ``code`` + English message)."""
    body: dict[str, Any] = {"ok": False, "code": code, "error": message}
    if detail is not None:
        body["detail"] = detail
    return JSONResponse(body, status_code=status)


@router.get("/status")
def get_status() -> Any:
    """Service + port + bridge reachability + capabilities. Never carries the token."""
    try:
        return logic.build_status()
    except Exception as exc:  # health: surface the reason instead of a 500 traceback
        return fail(500, "STATUS_FAILED", str(exc))


@router.get("/pairing")
def get_pairing() -> Any:
    """Proxy the bridge's one-time pairing code as a PNG QR the browser can show."""
    try:
        return logic.build_pairing()
    except logic.BridgeUnavailable as exc:
        return fail(502, "BRIDGE_UNREACHABLE", str(exc))
    except Exception as exc:
        return fail(500, "PAIRING_FAILED", str(exc))


@router.get("/config")
def get_config() -> Any:
    """Current config, with ``repos.json``'s ``scanDirs`` as the source of truth (G3)."""
    return logic.build_config()


@router.put("/config")
def put_config(payload: Optional[dict] = Body(default=None)) -> Any:
    """Validate then write atomically (tmp → rename, 0600).

    A partial body is merged onto the current file, so the tab can save one field
    without shipping the whole document back. When ``scanDirs`` changes it is
    pushed to the bridge and ``repos.json`` in the same request (G3).
    """
    paths = logic.resolve_paths()
    current = logic.build_config(paths)["config"]
    merged: dict[str, Any] = dict(current)
    if isinstance(payload, dict):
        merged.update(payload)
    result = logic.validate_config(merged)
    if not result["ok"]:
        return JSONResponse(
            {
                "ok": False,
                "code": "INVALID_CONFIG",
                "errors": result["errors"],
                "messages": result["messages"],
            },
            status_code=400,
        )
    try:
        logic.write_config_atomic(paths["configPath"], result["value"])
    except OSError as exc:
        return fail(500, "WRITE_FAILED", str(exc))
    body: dict[str, Any] = {"ok": True, "config": logic.build_config(paths)["config"]}
    if isinstance(payload, dict) and "scanDirs" in payload:
        try:
            body["sync"] = logic.sync_scan_dirs(paths, result["value"].get("scanDirs"))
        except OSError as exc:
            body["sync"] = {"ok": False, "error": f"repos.json could not be written: {exc}"}
    return body


@router.get("/repos")
def get_repos() -> Any:
    """Merged repository list + ``scanDirs`` (bridge when up, ``repos.json`` when not)."""
    try:
        return logic.build_repos()
    except Exception as exc:  # health: surface the reason instead of a 500 traceback
        return fail(500, "REPOS_FAILED", str(exc))


@router.post("/repos")
def post_repos(payload: Optional[dict] = Body(default=None)) -> Any:
    """``add|hide|unhide|pin|unpin|createBoard`` — then return the fresh list."""
    try:
        result = logic.repos_action(payload=payload)
    except Exception as exc:
        return fail(500, "REPOS_FAILED", str(exc))
    if not result.get("ok"):
        return JSONResponse(result, status_code=400)
    return result


@router.get("/snippets")
def get_snippets(
    kind: str = Query("chat", pattern="^(chat|term)$"),
    lang: str = Query("en", pattern="^(en|ja)$"),
) -> Any:
    """Chat/terminal snippets through the bridge, or the saved store when it is down."""
    try:
        return logic.build_snippets(kind=kind, lang=lang)
    except ValueError as exc:
        return fail(400, "INVALID_KIND", str(exc))
    except Exception as exc:
        return fail(500, "SNIPPETS_FAILED", str(exc))


@router.put("/snippets")
def put_snippets(
    payload: Optional[dict] = Body(default=None),
    kind: str = Query("chat", pattern="^(chat|term)$"),
    lang: str = Query("en", pattern="^(en|ja)$"),
) -> Any:
    """Save Hot/Hidden overrides and custom snippets (`reset:true` restores defaults)."""
    try:
        return logic.save_snippets(kind=kind, lang=lang, payload=payload)
    except ValueError as exc:
        return fail(400, "INVALID_KIND", str(exc))
    except OSError as exc:
        return fail(500, "WRITE_FAILED", str(exc))
    except Exception as exc:
        return fail(500, "SNIPPETS_FAILED", str(exc))


@router.get("/pipeline")
def get_pipeline(board: Optional[str] = Query(None)) -> Any:
    """Architect runner ＋ SOUL/skill 適用状態 ＋ 未起票 SPEC（SPEC V5 §3.2 / D25）。"""
    try:
        return logic.build_pipeline(board=board)
    except Exception as exc:  # health: surface the reason instead of a 500 traceback
        return fail(500, "PIPELINE_FAILED", str(exc))


@router.post("/pipeline")
def post_pipeline(payload: Optional[dict] = Body(default=None)) -> Any:
    """``optimize``（SOUL.md ＋ スキル配置）または ``setRunner``（hermes 固定 / Hermes Native）。"""
    try:
        result = logic.pipeline_action(payload=payload)
    except Exception as exc:
        return fail(500, "PIPELINE_FAILED", str(exc))
    if not result.get("ok"):
        return JSONResponse(result, status_code=400)
    return result


@router.get("/logs")
def get_logs(
    file_name: str = Query("gateway", alias="file", pattern="^(gateway|errors|pilot|audit)$"),
    lines: int = Query(120, ge=1, le=1000),
) -> Any:
    """Tail of one whitelisted log — redacted before it leaves the process."""
    try:
        return logic.build_logs(name=file_name, lines=lines)
    except ValueError as exc:
        return fail(400, "INVALID_FILE", str(exc))
    except Exception as exc:
        return fail(500, "LOGS_FAILED", str(exc))


@router.post("/service/{action}")
def post_service(action: str) -> Any:
    """Spawn ``hermes-pilot service <action>`` and return its stdout."""
    try:
        return logic.run_service(action)
    except ValueError as exc:
        return fail(400, "UNKNOWN_ACTION", str(exc))
    except logic.MissingCli as exc:
        return fail(409, "CLI_MISSING", str(exc))
    except Exception as exc:
        return fail(500, "SERVICE_FAILED", str(exc))
