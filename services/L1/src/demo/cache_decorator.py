"""
Python port of the L1 cache dedup wrapper.

Provides a decorator that wraps an expensive function (e.g., an OpenAI chat call)
with vector deduplication against the L1 cache service.
"""

from __future__ import annotations

import functools
import hashlib
import json
from typing import Any, Callable, Dict, Optional, TypeVar

import requests

F = TypeVar("F", bound=Callable[..., str])


class CacheDedupOptions(Dict[str, Any]):
    ns: str
    base_url: str
    max_distance: float
    ttl_seconds: Optional[int]
    top_k: int
    session: requests.Session


def wrap_with_cache_dedup(
    *,
    ns: str,
    base_url: str = "http://localhost:8080",
    max_distance: float = 0.5,
    ttl_seconds: Optional[int] = 3600,
    top_k: int = 1,
    session: Optional[requests.Session] = None,
    key_fn: Optional[Callable[..., str]] = None,
) -> Callable[[F], F]:
    """
    Decorates a synchronous function so it consults L1 before executing.
    The decorated function must return a JSON-serializable result (usually a string).
    """

    if not ns:
        raise ValueError("wrap_with_cache_dedup requires a namespace (ns)")

    sess = session or requests.Session()

    def decorator(fn: F) -> F:
        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            cache_query = _extract_query(args, kwargs, key_fn)
            serialized_args = None
            if not cache_query:
                serialized_args = _serialize_args(args, kwargs)
                cache_query = serialized_args

            # ----- Lookup -----
            try:
                cache_id = _make_cache_id(ns, cache_query)

                direct = _fetch_cache_record(sess, ns, base_url, cache_id)
                if direct is not None:
                    print(f"[cache hit @ exact] item_id={cache_id}")
                    return direct

                payload = {"ns": ns, "query": cache_query, "top_k": top_k}
                res = sess.post(f"{base_url}/search.vector", json=payload, timeout=30)
                res.raise_for_status()
                results = res.json().get("results") or []
                if results:
                    best = results[0]
                    score = float(best.get("score", float("inf")))
                    print(f"[dedup] search hit score={score:.3f} item={best.get('item_id')}")
                    if score <= max_distance:
                        doc = _fetch_cache_record(sess, ns, base_url, best["item_id"])
                        if doc is not None:
                            print(f"[cache hit @ {score:.3f}]")
                            return doc
                else:
                    print("[dedup] no cached results")
            except Exception as err:  # noqa: BLE001
                print(f"[cache lookup failed] {err}")

            # ----- Miss path -----
            result = fn(*args, **kwargs)

            try:
                cache_id = _make_cache_id(ns, cache_query)
                body: Dict[str, Any] = {
                    "ns": ns,
                    "item_id": cache_id,
                    "text": cache_query,
                    "meta": {
                        "response": result,
                        "query": cache_query,
                        "cache_id": cache_id,
                    },
                }
                if ttl_seconds is not None:
                    body["ttl_s"] = ttl_seconds
                if serialized_args and cache_query != serialized_args:
                    body["meta"]["serialized_args"] = serialized_args
                print(f"[dedup] write payload={body}")
                write_res = sess.post(f"{base_url}/cache.write", json=body, timeout=30)
                write_res.raise_for_status()
                payload = write_res.json()
                print(
                    f"[dedup] cached item_id={payload.get('item_id')} vectorized={payload.get('vectorized')} "
                    f"vector_error={payload.get('vector_error')}"
                )
            except Exception as err:  # noqa: BLE001
                print(f"[cache write failed] {err}")

            return result

        return wrapper  # type: ignore[return-value]

    return decorator


def _extract_query(
    args: Any,
    kwargs: Any,
    key_fn: Optional[Callable[..., str]],
) -> Optional[str]:
    if key_fn:
        try:
            key = key_fn(*args, **kwargs)
            if isinstance(key, str) and key.strip():
                return key
        except Exception:
            pass

    # Prefer explicit keyword argument named "prompt" or "query"
    for candidate in ("prompt", "query", "text"):
        value = kwargs.get(candidate)
        if isinstance(value, str) and value.strip():
            return value.strip()

    # Fallback to first positional string argument
    for arg in args:
        if isinstance(arg, str) and arg.strip():
            return arg.strip()

    return None


def _serialize_args(args: Any, kwargs: Any) -> str:
    try:
        return json.dumps({"args": args, "kwargs": kwargs}, sort_keys=True, separators=(",", ":"), default=str)
    except TypeError:
        return json.dumps([args, kwargs], default=str)


def _fetch_cache_record(sess: requests.Session, ns: str, base_url: str, item_id: str) -> Optional[str]:
    res = sess.get(f"{base_url}/cache.get", params={"ns": ns, "item_id": item_id}, timeout=30)
    if res.status_code == 404:
        return None
    res.raise_for_status()
    payload = res.json()
    meta = payload.get("meta")
    if isinstance(meta, dict):
        response = meta.get("response")
        if isinstance(response, str):
            return response
    return None


def _make_cache_id(ns: str, query: str) -> str:
    digest = hashlib.sha1(query.encode("utf-8")).hexdigest()
    return f"dedup:{ns}:{digest}"
