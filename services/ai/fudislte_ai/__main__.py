"""Entry point.

    python -m fudislte_ai [serve]     run the worker (configuration from FUDISLTE_AI_* variables)
    python -m fudislte_ai healthcheck exit 0 when GET /healthz answers 200 (container health)
"""

from __future__ import annotations

import logging
import os
import sys
import urllib.request


def _healthcheck() -> int:
    port = os.environ.get("FUDISLTE_AI_HTTP_ADDR", ":8090").rpartition(":")[2] or "8090"
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(f"http://127.0.0.1:{port}/healthz", timeout=4) as response:
            return 0 if response.status == 200 else 1
    except Exception:
        return 1


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    command = argv[0] if argv else "serve"
    if command == "healthcheck":
        return _healthcheck()
    if command != "serve":
        print(__doc__, file=sys.stderr)
        return 2

    from .config import ConfigError, load_settings

    try:
        settings = load_settings()
    except ConfigError as exc:
        print(f"fudislte-ai: invalid configuration:\n{exc}", file=sys.stderr)
        return 2

    logging.basicConfig(
        level=settings.log_level.upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        stream=sys.stderr,
    )
    import uvicorn

    from .app import create_app

    uvicorn.run(
        create_app(settings),
        host=settings.http_host,
        port=settings.http_port,
        log_level=settings.log_level,
        access_log=False,
        server_header=False,
        proxy_headers=False,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
