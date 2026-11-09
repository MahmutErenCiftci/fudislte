"""Splits documents into overlapping chunks for embedding."""

from __future__ import annotations

CHUNK_CHARS = 1200
OVERLAP_CHARS = 150
MAX_CHUNKS = 2000
_BREAKS = ("\n\n", "\n", ". ", "! ", "? ", "; ", " ")


def chunk_text(text: str, max_chars: int = CHUNK_CHARS, overlap: int = OVERLAP_CHARS) -> list[str]:
    """Cuts at paragraph, sentence or word boundaries where possible, never mid-word
    unless a single word is longer than a chunk."""
    text = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not text:
        return []
    if len(text) <= max_chars:
        return [text]

    chunks: list[str] = []
    start, n = 0, len(text)
    while start < n and len(chunks) < MAX_CHUNKS:
        end = min(start + max_chars, n)
        if end < n:
            window = text[start:end]
            for sep in _BREAKS:
                cut = window.rfind(sep, int(max_chars * 0.5))
                if cut != -1:
                    end = start + cut + len(sep)
                    break
        piece = text[start:end].strip()
        if piece:
            chunks.append(piece)
        if end >= n:
            break
        next_start = max(end - overlap, start + 1)
        space = text.find(" ", next_start, end)
        start = space + 1 if space != -1 else end
    return chunks
