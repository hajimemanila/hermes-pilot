"""Hermes Pilot — plugin package entry (installed as ``__init__.py``).

A user plugin's dashboard backend is only mounted when the plugin is a real,
enabled Hermes plugin, so this module has to exist even though there is no
agent-side surface: ``hermes plugins enable hermes-pilot`` resolves the name
through it. ``register`` is intentionally a no-op — the whole plugin is the
dashboard tab plus its FastAPI router under ``dashboard/``.
"""

from __future__ import annotations


def register(ctx) -> None:  # noqa: ARG001 - signature fixed by the plugin API
    """No agent-side tools, hooks or commands; the dashboard half is the plugin."""
    return None
