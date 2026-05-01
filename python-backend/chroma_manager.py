"""
witness/python-backend/chroma_manager.py

ChromaDB semantic search engine for Witness.

What this does:
  - Keeps a persistent local vector database at python-backend/chroma_data/
  - embed_entry()     -- converts a journal entry's text into a semantic fingerprint and stores it
  - embed_rant()      -- same, but for rant entries (same collection, tagged differently)
  - semantic_search() -- finds entries whose meaning matches a query
  - delete_entry()    -- removes a journal entry from the vector DB
  - delete_rant()     -- removes a rant from the vector DB
  - chroma_status()   -- returns health info for the /health endpoint

Everything runs 100% offline. No OpenAI, no external APIs.
ChromaDB's default embedding function uses a small bundled local model (~22 MB).
On first run it downloads that model once. After that, fully offline.

IMPORTANT: Designed to fail gracefully.
If ChromaDB is unavailable for any reason, all functions return safe empty values
so the app continues working with keyword search only.
"""

import logging
from pathlib import Path
from typing import Optional

log = logging.getLogger("witness.chroma")

# ─── PATH SETUP ───────────────────────────────────────────────────────────────

# chroma_data/ lives next to this file, inside python-backend/
CHROMA_DIR = Path(__file__).parent / "chroma_data"
COLLECTION_NAME = "witness_entries"

# ─── LAZY INIT ────────────────────────────────────────────────────────────────
# We initialize ChromaDB once on first use and reuse the client + collection.
# If init fails, _collection stays None and every function exits safely.

_client     = None
_collection = None


def _get_collection():
    """
    Return the ChromaDB collection, initializing it on first call.
    Returns None if ChromaDB cannot be initialized — app continues without it.
    """
    global _client, _collection

    if _collection is not None:
        return _collection

    try:
        import chromadb
        from chromadb.utils.embedding_functions import DefaultEmbeddingFunction

        CHROMA_DIR.mkdir(parents=True, exist_ok=True)

        _client = chromadb.PersistentClient(path=str(CHROMA_DIR))

        # DefaultEmbeddingFunction uses a small local sentence-transformer model.
        # First run downloads it (~22 MB) to a local cache — after that, no internet needed.
        embedding_fn = DefaultEmbeddingFunction()

        _collection = _client.get_or_create_collection(
            name=COLLECTION_NAME,
            embedding_function=embedding_fn,
            metadata={"hnsw:space": "cosine"}  # cosine similarity -- best for text meaning
        )

        log.info(
            f"ChromaDB ready. Collection '{COLLECTION_NAME}' "
            f"has {_collection.count()} entries."
        )
        return _collection

    except Exception as e:
        log.warning(f"ChromaDB init failed -- semantic search disabled. Reason: {e}")
        return None


# ─── PUBLIC API ───────────────────────────────────────────────────────────────

def embed_entry(entry_id: int, text: str, entry_date: str = "") -> Optional[str]:
    """
    Embed a journal entry into ChromaDB.

    Args:
        entry_id:   The SQLite row ID from the entries table.
        text:       The transcript text to embed.
        entry_date: The date string (e.g. "2025-04-28") -- stored as metadata.

    Returns:
        The chroma_id string if successful, None if it failed.

    Uses upsert -- safe to call multiple times on the same entry_id.
    Designed to be called from a background thread after the entry is saved.
    """
    col = _get_collection()
    if col is None:
        return None

    if not text or not text.strip():
        log.debug(f"embed_entry({entry_id}): skipping empty text")
        return None

    try:
        chroma_id = f"entry_{entry_id}"
        col.upsert(
            ids=[chroma_id],
            documents=[text.strip()],
            metadatas=[{
                "type":       "daily",
                "entry_id":   entry_id,
                "entry_date": entry_date,
            }]
        )
        log.debug(f"Embedded journal entry {entry_id} as '{chroma_id}'")
        return chroma_id

    except Exception as e:
        log.warning(f"embed_entry({entry_id}) failed: {e}")
        return None


def embed_rant(rant_id: int, text: str, created_at: str = "") -> Optional[str]:
    """
    Embed a rant entry into ChromaDB.
    Rants share the same collection as journal entries, tagged with type='rant'.

    Args:
        rant_id:    The SQLite row ID from the rants table.
        text:       The rant transcript to embed.
        created_at: ISO timestamp string -- stored as metadata.

    Returns:
        The chroma_id string if successful, None if it failed.
    """
    col = _get_collection()
    if col is None:
        return None

    if not text or not text.strip():
        return None

    try:
        chroma_id = f"rant_{rant_id}"
        col.upsert(
            ids=[chroma_id],
            documents=[text.strip()],
            metadatas=[{
                "type":       "rant",
                "rant_id":    rant_id,
                "entry_date": created_at[:10] if created_at else "",
            }]
        )
        log.debug(f"Embedded rant {rant_id} as '{chroma_id}'")
        return chroma_id

    except Exception as e:
        log.warning(f"embed_rant({rant_id}) failed: {e}")
        return None


def semantic_search(query: str, n_results: int = 10) -> list[dict]:
    """
    Find entries whose meaning is semantically closest to the query string.

    Args:
        query:     Natural language search query.
        n_results: Max number of results to return (default 10).

    Returns:
        List of dicts, each containing:
          {
            "chroma_id":  str,   -- e.g. "entry_42" or "rant_7"
            "type":       str,   -- "daily" | "rant"
            "entry_id":   int|None,  -- SQLite row ID in entries table (if daily)
            "rant_id":    int|None,  -- SQLite row ID in rants table (if rant)
            "entry_date": str,
            "distance":   float, -- 0.0 = identical meaning, 1.0 = completely different
          }

        Returns [] if ChromaDB is unavailable or query is empty.
    """
    col = _get_collection()
    if col is None:
        return []

    if not query or not query.strip():
        return []

    try:
        count = col.count()
        if count == 0:
            return []

        # Can't request more results than exist in the collection
        n = min(n_results, count)

        results = col.query(
            query_texts=[query.strip()],
            n_results=n,
            include=["metadatas", "distances"]
        )

        output = []
        metadatas = results.get("metadatas", [[]])[0]
        distances = results.get("distances", [[]])[0]
        ids       = results.get("ids", [[]])[0]

        for chroma_id, meta, dist in zip(ids, metadatas, distances):
            entry_type = meta.get("type", "daily")
            output.append({
                "chroma_id":  chroma_id,
                "type":       entry_type,
                "entry_id":   meta.get("entry_id"),
                "rant_id":    meta.get("rant_id"),
                "entry_date": meta.get("entry_date", ""),
                "distance":   round(dist, 4),
            })

        return output

    except Exception as e:
        log.warning(f"semantic_search('{query}') failed: {e}")
        return []


def delete_entry(entry_id: int) -> bool:
    """Remove a journal entry from ChromaDB. Safe if it was never embedded."""
    col = _get_collection()
    if col is None:
        return False
    try:
        col.delete(ids=[f"entry_{entry_id}"])
        return True
    except Exception as e:
        log.debug(f"delete_entry({entry_id}) chroma: {e}")
        return False


def delete_rant(rant_id: int) -> bool:
    """Remove a rant from ChromaDB. Safe if it was never embedded."""
    col = _get_collection()
    if col is None:
        return False
    try:
        col.delete(ids=[f"rant_{rant_id}"])
        return True
    except Exception as e:
        log.debug(f"delete_rant({rant_id}) chroma: {e}")
        return False


def chroma_status() -> dict:
    """Returns ChromaDB health info. Used by the /health endpoint."""
    col = _get_collection()
    if col is None:
        return {"available": False, "count": 0}
    try:
        return {"available": True, "count": col.count()}
    except Exception:
        return {"available": False, "count": 0}
