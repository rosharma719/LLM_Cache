import os, time, requests, json, gradio as gr

L1 = os.getenv("L1_BASE_URL", "http://localhost:8080")
NS = os.getenv("L1_NS", "demo")
TOP_K = int(os.getenv("L1_TOP_K", "3"))
MAX_DISTANCE = float(os.getenv("L1_MAX_DISTANCE", "1.25"))

def l1_search(query):
    r = requests.post(f"{L1}/search.vector", json={"ns": NS, "query": query, "top_k": TOP_K})
    r.raise_for_status()
    return r.json().get("results", [])

def l1_get(item_id):
    r = requests.get(f"{L1}/cache.get", params={"ns": NS, "item_id": item_id})
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()

def l1_write(query, response, ttl_s=None):
    payload = {
        "ns": NS,
        "text": query,
        "ttl_s": ttl_s,
        "meta": {
            "response": response,
            "provider": "demo",
            "model": "demo-local",
            "cached_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        }
    }
    r = requests.post(f"{L1}/cache.write", json=payload)
    r.raise_for_status()
    return r.json()

def l1_delete(item_id):
    r = requests.delete(f"{L1}/cache.delete", json={"ns": NS, "item_id": item_id})
    if r.status_code == 404:
        return {"ok": False}
    r.raise_for_status()
    return r.json()

def l1_list():
    # list random sample of IDs from the namespace
    r = requests.get(f"{L1}/cache.list", params={"ns": NS})
    r.raise_for_status()
    return r.json().get("item_ids", [])

def fake_llm(prompt):
    # stand-in for OpenAI; you can swap to real OpenAI if you want
    return f"[fresh reply] {prompt[::-1]}"

def ask(prompt, ttl_seconds):
    logs = []
    logs.append(f"→ Query: {prompt!r}")
    results = l1_search(prompt)
    logs.append(f"search.vector returned {len(results)} result(s)")
    logs.append(json.dumps(results[:3], indent=2))

    if results:
        best = results[0]
        score = best.get("score", None)
        logs.append(f"best.score={score}")
        if score is not None and score <= MAX_DISTANCE:
            rec = l1_get(best["item_id"])
            if rec and isinstance(rec.get("meta"), dict) and "response" in rec["meta"]:
                logs.append("HIT: using cached response")
                return rec["meta"]["response"], json.dumps(rec, indent=2), "\n".join(logs)

    logs.append("MISS: calling LLM …")
    reply = fake_llm(prompt)
    write_res = l1_write(prompt, reply, ttl_s=int(ttl_seconds) if ttl_seconds else None)
    logs.append(f"persisted item_id={write_res.get('item_id')} vectorized={write_res.get('vectorized')}")
    return reply, json.dumps(write_res, indent=2), "\n".join(logs)

def browse():
    ids = l1_list()
    return "\n".join(ids) or "(no items)"

def inspect(item_id):
    if not item_id.strip():
        return "(enter an item_id)"
    rec = l1_get(item_id.strip())
    return json.dumps(rec, indent=2) if rec else "(not found)"

def delete_item(item_id):
    item_id = item_id.strip()
    if not item_id:
        return "(enter an item_id)"
    res = l1_delete(item_id)
    if res.get("ok"):
        return f"Deleted {item_id}"
    return f"{item_id} was not found or already removed"

with gr.Blocks() as demo:
    gr.Markdown("# L1 Cache Demo — Hits, Misses, and Live Browser")

    with gr.Tab("Chat"):
        inp = gr.Textbox(label="Prompt")
        ttl = gr.Number(value=3600, label="TTL seconds (optional)")
        out = gr.Textbox(label="Assistant Response")
        meta = gr.Code(label="Write/Get Payload")
        log = gr.Code(label="Log")
        btn = gr.Button("Ask")
        btn.click(fn=ask, inputs=[inp, ttl], outputs=[out, meta, log])

    with gr.Tab("Cache Browser"):
        ids_box = gr.Textbox(label="Item IDs (random sample)", lines=10)
        list_btn = gr.Button("List")
        list_btn.click(fn=browse, outputs=ids_box)

        item_id = gr.Textbox(label="Inspect item_id")
        rec_box = gr.Code(label="Record")
        get_btn = gr.Button("Get")
        get_btn.click(fn=inspect, inputs=item_id, outputs=rec_box)

        delete_status = gr.Textbox(label="Delete status", interactive=False)
        del_btn = gr.Button("Delete")
        del_btn.click(fn=delete_item, inputs=item_id, outputs=delete_status)

if __name__ == "__main__":
    demo.launch()
