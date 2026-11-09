"""Transcription endpoint with a fake transcriber (no Whisper model is downloaded)."""

from __future__ import annotations

from typing import BinaryIO

from conftest import error_code, make_settings, running

from fudislte_ai.schemas import Segment, TranscribeResponse
from fudislte_ai.transcribe import TranscriptionError, TranscriptionModelError

AUDIO = b"RIFF....WAVEfmt fake audio bytes"


class FakeTranscriber:
    def __init__(self, fail: bool = False, model_missing: bool = False) -> None:
        self.fail = fail
        self.model_missing = model_missing
        self.seen: list[tuple[str | None, bytes]] = []

    async def transcribe(self, audio: BinaryIO, language: str | None) -> TranscribeResponse:
        self.seen.append((language, audio.read()))
        if self.model_missing:
            raise TranscriptionModelError("LocalEntryNotFoundError")
        if self.fail:
            raise TranscriptionError("InvalidDataError")
        return TranscribeResponse(
            language=language or "tr",
            duration=4.2,
            segments=[Segment(start=0.0, end=2.1, text="Merhaba."), Segment(start=2.1, end=4.2, text="Başlayalım.")],
        )


def test_transcription_disabled_by_default() -> None:
    with running() as w:
        r = w.multipart("/v1/transcribe", {"audio": ("a.wav", AUDIO, "audio/wav")})
        assert r.status_code == 503 and error_code(r) == "capability_disabled"
        assert w.client.get("/healthz").json()["capabilities"]["transcription"] is False


def test_whisper_model_without_the_extra_stays_disabled() -> None:
    with running(make_settings(whisper_model="small")) as w:
        assert w.client.get("/healthz").json()["capabilities"]["transcription"] is False


def test_transcribe_returns_segments_from_the_upload() -> None:
    fake = FakeTranscriber()
    with running(transcriber=fake) as w:
        assert w.client.get("/healthz").json()["capabilities"]["transcription"] is True
        r = w.multipart("/v1/transcribe", {"audio": ("meeting.wav", AUDIO, "audio/wav")}, {"language": "tr"})
        assert r.status_code == 200, r.text
        assert r.json() == {
            "language": "tr",
            "duration": 4.2,
            "segments": [
                {"start": 0.0, "end": 2.1, "text": "Merhaba."},
                {"start": 2.1, "end": 4.2, "text": "Başlayalım."},
            ],
        }
        assert fake.seen == [("tr", AUDIO)]


def test_transcribe_rejects_bad_input() -> None:
    with running(transcriber=FakeTranscriber(fail=True)) as w:
        r = w.multipart("/v1/transcribe", {"audio": ("a.wav", AUDIO, "audio/wav")}, {"language": "de"})
        assert r.status_code == 422 and error_code(r) == "validation_failed"
        r = w.multipart("/v1/transcribe", {"audio": ("a.wav", b"", "audio/wav")})
        assert r.status_code == 422 and error_code(r) == "audio_unreadable"
        r = w.multipart("/v1/transcribe", {"audio": ("a.wav", AUDIO, "audio/wav")})
        assert r.status_code == 422 and error_code(r) == "audio_unreadable"
        # The multipart body is signed like any other.
        r = w.client.post("/v1/transcribe", files={"audio": ("a.wav", AUDIO, "audio/wav")})
        assert r.status_code == 401
    with running(transcriber=FakeTranscriber(model_missing=True)) as w:
        r = w.multipart("/v1/transcribe", {"audio": ("a.wav", AUDIO, "audio/wav")})
        assert r.status_code == 503 and error_code(r) == "model_unavailable"


def test_audio_size_limit_is_separate_from_json_limit() -> None:
    settings = make_settings(max_body_bytes=1024, max_audio_bytes=4096)
    with running(settings, transcriber=FakeTranscriber()) as w:
        r = w.multipart("/v1/transcribe", {"audio": ("a.wav", b"x" * 3000, "audio/wav")})
        assert r.status_code == 200
        r = w.multipart("/v1/transcribe", {"audio": ("a.wav", b"x" * 5000, "audio/wav")})
        assert r.status_code == 413 and error_code(r) == "body_too_large"
