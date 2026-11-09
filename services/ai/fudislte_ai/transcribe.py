"""Optional local speech-to-text with faster-whisper (MIT), installed as the `whisper` extra.

Audio is decoded and transcribed inside the worker straight from the request's upload
(memory up to 1 MiB, then a temporary file on the tmpfs of the Compose overlay); nothing
is kept after the request.
"""

from __future__ import annotations

import asyncio
import importlib.util
import logging
import threading
from typing import Any, BinaryIO, Protocol

from .schemas import Segment, TranscribeResponse

log = logging.getLogger("fudislte_ai.transcribe")


class TranscriptionError(Exception):
    """The audio could not be decoded or transcribed."""


class TranscriptionModelError(Exception):
    """The configured Whisper model could not be loaded (missing files, no network)."""


class Transcriber(Protocol):
    async def transcribe(self, audio: BinaryIO, language: str | None) -> TranscribeResponse: ...


def whisper_installed() -> bool:
    return importlib.util.find_spec("faster_whisper") is not None


class WhisperTranscriber:
    """Loads the model on first use and runs one transcription at a time in a thread."""

    def __init__(self, model: str, device: str = "auto", compute_type: str = "default", download_root: str = "") -> None:
        self.model_name = model
        self.device = device
        self.compute_type = compute_type
        self.download_root = download_root or None
        self._model: Any = None
        self._load_lock = threading.Lock()
        self._busy = asyncio.Semaphore(1)

    def _load(self) -> Any:
        with self._load_lock:
            if self._model is None:
                from faster_whisper import WhisperModel  # optional dependency

                log.info("loading whisper model %s on %s", self.model_name, self.device)
                try:
                    self._model = WhisperModel(
                        self.model_name,
                        device=self.device,
                        compute_type=self.compute_type,
                        download_root=self.download_root,
                    )
                except Exception as exc:
                    log.error("cannot load whisper model %s: %s", self.model_name, exc)
                    raise TranscriptionModelError(type(exc).__name__) from None
            return self._model

    def _run(self, audio: BinaryIO, language: str | None) -> TranscribeResponse:
        model = self._load()
        try:
            segments, info = model.transcribe(audio, language=language, vad_filter=True)
            out = [
                Segment(start=round(s.start, 2), end=round(s.end, 2), text=s.text.strip())
                for s in segments
                if s.text.strip()
            ]
        except Exception as exc:  # decoding errors come from PyAV with many types
            raise TranscriptionError(type(exc).__name__) from None
        return TranscribeResponse(language=info.language, duration=round(info.duration, 2), segments=out)

    async def transcribe(self, audio: BinaryIO, language: str | None) -> TranscribeResponse:
        async with self._busy:
            return await asyncio.to_thread(self._run, audio, language)
