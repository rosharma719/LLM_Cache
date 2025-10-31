"""
Simple CLI demo that wraps OpenAI chat completions with the L1 cache.

Usage:
    export OPENAI_API_KEY=sk-...
    export OPENAI_PROJECT=proj_...        # if required by your key
    export OPENAI_ORGANIZATION=org_...    # optional, only when needed
    export L1_BASE_URL=http://localhost:8080
    export L1_NS=demo
    python -m src.demo.chat_cli

Dependencies: requests (install via `pip install requests`).
"""

import os
import sys
from typing import List

import requests

from .cache_decorator import wrap_with_cache_dedup


L1_BASE_URL = os.getenv("L1_BASE_URL", "http://localhost:8080")
L1_NAMESPACE = os.getenv("L1_NS", "demo")
MAX_DISTANCE = float(os.getenv("L1_MAX_DISTANCE", "0.5"))
TTL_SECONDS = int(os.getenv("L1_TTL_SECONDS", "3600"))

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_MODEL = os.getenv("OPENAI_CHAT_MODEL", "gpt-4o-mini")
OPENAI_ORG = os.getenv("OPENAI_ORGANIZATION")
OPENAI_PROJECT = os.getenv("OPENAI_PROJECT")


def call_openai(messages: List[dict]) -> str:
    if not OPENAI_API_KEY:
        raise RuntimeError("OPENAI_API_KEY not configured")

    headers = {
        "Authorization": f"Bearer {OPENAI_API_KEY}",
        "Content-Type": "application/json",
    }
    if OPENAI_ORG:
        headers["OpenAI-Organization"] = OPENAI_ORG
    if OPENAI_PROJECT:
        headers["OpenAI-Project"] = OPENAI_PROJECT

    body = {
        "model": OPENAI_MODEL,
        "messages": messages,
        "temperature": 0.3,
    }
    res = requests.post("https://api.openai.com/v1/chat/completions", headers=headers, json=body, timeout=60)
    res.raise_for_status()
    payload = res.json()
    content = payload["choices"][0]["message"]["content"]
    return content.strip()


@wrap_with_cache_dedup(
    ns=L1_NAMESPACE,
    base_url=L1_BASE_URL,
    max_distance=MAX_DISTANCE,
    ttl_seconds=TTL_SECONDS,
)
def deduped_chat(prompt: str, history: List[dict]) -> str:
    """
    Decorated function that first checks L1 before making an OpenAI call.
    The wrapper prints `[cache hit @ …]` when a cached answer is reused.
    """
    messages = history + [{"role": "user", "content": prompt}]
    return call_openai(messages)


def main() -> None:
    print("LLM Cache CLI — type 'exit' to quit.")
    history: List[dict] = []

    while True:
        try:
            prompt = input("You: ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nbye!")
            return

        if not prompt:
            continue
        if prompt.lower() in {"exit", "quit"}:
            print("bye!")
            return

        try:
            reply = deduped_chat(prompt, history)
        except Exception as err:
            print(f"[error calling OpenAI] {err}", file=sys.stderr)
            continue

        print(reply)
        history.append({"role": "user", "content": prompt})
        history.append({"role": "assistant", "content": reply})


if __name__ == "__main__":
    main()
