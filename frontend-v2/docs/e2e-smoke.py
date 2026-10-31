"""End-to-end functional test of the flow the frontend-v2 UI drives.

This exercises the real running backend on the real port, with the real auth
token, in the same order and with the same payload shapes the renderer sends.
It is not a mock: the app under test is the one currently on screen.

SECURITY: the auth token is read into memory and sent as a header. It is
never printed, never written anywhere, and never included in any output.
Same for the port file's neighbours -- nothing else in BASE_DIR is read.
"""
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = os.path.join(os.environ["LOCALAPPDATA"], "ITaxReplyAgent")

port = io.open(os.path.join(BASE, "port-rs.txt"), encoding="utf-8").read().strip()
# The token: into a variable, out as a header, never into stdout.
TOKEN = io.open(os.path.join(BASE, "auth_token.txt"), encoding="utf-8").read().strip()
ROOT = "http://127.0.0.1:" + port

passed = []
failed = []


def check(name, cond, detail=""):
    (passed if cond else failed).append(name)
    print(("  PASS  " if cond else "  FAIL  ") + name + (("  -- " + detail) if detail else ""))


def req(path, method="GET", body=None, timeout=60):
    headers = {}
    data = None
    if method != "GET":
        headers["X-ITax-Auth"] = TOKEN
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    r = urllib.request.Request(ROOT + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
            try:
                return resp.status, json.loads(raw)
            except ValueError:
                return resp.status, raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, raw


print("== 1. health: what the rail polls ==")
st, health = req("/health")
check("GET /health -> 200", st == 200, "got %s" % st)
if isinstance(health, dict):
    print("        keys: %s" % sorted(health.keys()))
    check("health reports ollama_running", "ollama_running" in health)
    print("        ollama_running=%r" % health.get("ollama_running"))

print("== 2. models: what the Model dropdown lists ==")
st, models = req("/models")
check("GET /models -> 200", st == 200, "got %s" % st)
names = []
if isinstance(models, dict):
    for k in ("models", "available", "data"):
        if isinstance(models.get(k), list):
            names = models[k]
            break
elif isinstance(models, list):
    names = models
print("        %d model(s): %r" % (len(names), names[:5]))
check("at least one model offered", len(names) > 0)

print("== 3. auth is actually enforced on mutations ==")
valid_probe = {"text": "", "query": "ping", "model": None, "history": [],
               "session_id": None, "temperature": 0.2, "save_output": False}
r = urllib.request.Request(ROOT + "/generate", data=json.dumps(valid_probe).encode(),
                           headers={"Content-Type": "application/json"}, method="POST")
code = None
try:
    with urllib.request.urlopen(r, timeout=20) as resp:
        code = resp.status
except urllib.error.HTTPError as e:
    code = e.code
except Exception as e:
    code = repr(e)
check("POST /generate without token is rejected", code in (401, 403), "got %s" % code)

print("== 4. RAG status: what the Corpus view reads ==")
st, rag = req("/rag/status")
check("GET /rag/status -> 200", st == 200, "got %s" % st)
if isinstance(rag, dict):
    print("        keys: %s" % sorted(rag.keys()))

st, docs = req("/rag/documents")
check("GET /rag/documents -> 200", st == 200, "got %s" % st)

print("== 5. generate: the actual Draft reply button ==")
payload = {
    "text": "",
    "query": "In one short sentence, what is Section 148 of the Income Tax Act?",
    "model": None,
    "history": [],
    "session_id": None,
    "temperature": 0.2,
    "save_output": False,
}
t0 = time.time()
st, gen = req("/generate", method="POST", body=payload, timeout=600)
dt = time.time() - t0
check("POST /generate -> 200", st == 200, "got %s in %.1fs" % (st, dt))
text = ""
if isinstance(gen, dict):
    print("        keys: %s" % sorted(gen.keys()))
    for k in ("reply", "text", "response", "content", "draft"):
        if isinstance(gen.get(k), str) and gen[k].strip():
            text = gen[k]
            break
    if not text:
        print("        body (trunc): %s" % json.dumps(gen)[:400])
else:
    print("        non-dict body (trunc): %s" % str(gen)[:400])
check("generate returned non-empty text", len(text.strip()) > 0, "%d chars in %.1fs" % (len(text), dt))
if text:
    print("        first 200 chars: %r" % text[:200])

print()
print("PASSED %d / %d" % (len(passed), len(passed) + len(failed)))
if failed:
    print("FAILED: %s" % failed)
sys.exit(1 if failed else 0)
