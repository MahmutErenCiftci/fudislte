# syntax=docker/dockerfile:1
# FUDISLTE AI worker (ADR-0012): internal only, reached by the API, never through Caddy.
# Build context: repository root (services/ai/Dockerfile.dockerignore keeps it small).
#   docker build -f services/ai/Dockerfile -t fudislte/ai:dev .
#   docker build -f services/ai/Dockerfile --build-arg WITH_WHISPER=true -t fudislte/ai:dev .   # + speech-to-text
# Runs as an unprivileged user and works with a read-only root filesystem: it writes
# only to /tmp (mount a tmpfs) and /models (a volume, for Whisper models).
FROM python:3.12-slim AS build
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN python -m venv /opt/venv
COPY services/ai/requirements.lock /tmp/requirements.lock
RUN /opt/venv/bin/pip install --no-compile -r /tmp/requirements.lock
# Optional local transcription. faster-whisper is MIT; its PyAV dependency ships FFmpeg
# libraries (LGPL) — see docs/architecture/ai-worker.md before distributing this variant.
ARG WITH_WHISPER=false
ARG FASTER_WHISPER_VERSION=1.2.1
RUN if [ "$WITH_WHISPER" = "true" ]; then \
      /opt/venv/bin/pip install --no-compile "faster-whisper==${FASTER_WHISPER_VERSION}"; \
    fi
COPY services/ai/fudislte_ai /opt/fudislte/fudislte_ai
# Compile once at build time; the read-only container never writes bytecode.
RUN /opt/venv/bin/python -m compileall -q /opt/venv /opt/fudislte
# Licenses that travel with the image: FUDISLTE's own, Python's and those of every package
# installed in the virtual environment.
COPY LICENSE NOTICE /opt/licenses/
COPY scripts/licenses/python_notices.py /tmp/python_notices.py
RUN chmod 644 /opt/licenses/LICENSE /opt/licenses/NOTICE \
 && /opt/venv/bin/python /tmp/python_notices.py > /opt/licenses/THIRD_PARTY_NOTICES.txt

FROM python:3.12-slim
RUN groupadd --system --gid 10001 fudislte \
 && useradd --system --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent \
      --shell /usr/sbin/nologin fudislte \
 && install -d -o 10001 -g 10001 -m 0750 /models
COPY --from=build /opt/venv /opt/venv
COPY --from=build /opt/fudislte /opt/fudislte
COPY --from=build /opt/licenses /licenses
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONPATH=/opt/fudislte \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/models \
    FUDISLTE_AI_MODEL_DIR=/models \
    FUDISLTE_AI_HTTP_ADDR=:8090
WORKDIR /opt/fudislte
USER 10001:10001
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["python", "-m", "fudislte_ai", "healthcheck"]
ENTRYPOINT ["python", "-m", "fudislte_ai"]
CMD ["serve"]
