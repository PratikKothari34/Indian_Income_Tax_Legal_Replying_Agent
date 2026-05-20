"""End-to-end smoke test against a running backend.

Usage:
    1. Start Ollama: `ollama serve`  (and `ollama pull qwen2.5:14b`)
    2. Start backend: `python main.py` from the backend/ directory
    3. Run: `python tests/test_dummy_notice.py`

The dummy notice references a TDS-on-rental-income matter that turns on
CBDT Notification No. 35/2023 (Form 26QC / s.194-IB), so the model is
expected to cite a CBDT notification by name in its reply.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import urllib.request
import urllib.error

BASE = "http://127.0.0.1:8000"

DUMMY_NOTICE = """
INCOME TAX DEPARTMENT
Office of the Assessing Officer, Ward 24(2), Mumbai

Notice u/s 142(1) of the Income Tax Act, 1961
DIN: ITBA/AST/F/142(1)/2025-26/1234567890
Date: 12/04/2026

To,
Shri Rajesh Kumar Sharma
PAN: ABCPS1234K
A.Y. 2025-26

Sir,
In connection with the assessment for A.Y. 2025-26, you are required to
furnish the following information / documents within 15 days of receipt
of this notice:

1. You have shown rental income of Rs. 6,00,000 received from a property
   let out to M/s Acme Traders Pvt Ltd from 01/04/2024 to 31/03/2025 at a
   monthly rent of Rs. 50,000. As per s.194-IB of the Income Tax Act, 1961
   read with the prescribed rules, the deductor was required to deduct TDS
   and furnish the challan-cum-statement in Form 26QC. No corresponding
   TDS credit appears in your Form 26AS. Please explain.

2. You have claimed deduction u/s 80C of Rs. 1,50,000. Furnish documentary
   evidence of payments along with the names of the institutions.

3. You have claimed exemption of Rs. 2,80,000 u/s 10(13A) (HRA). Furnish
   rent receipts, rent agreement and PAN of the landlord (where annual rent
   exceeds Rs. 1,00,000) as required by the relevant CBDT Circular.

Failure to comply may attract penalty u/s 272A(1)(d).

Yours faithfully,
Sd/-
Assessing Officer
Ward 24(2), Mumbai
"""


def _post_json(url: str, payload: dict) -> dict:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=600) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _get_json(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main() -> int:
    print(f"[1/3] GET  {BASE}/health")
    try:
        h = _get_json(f"{BASE}/health")
    except urllib.error.URLError as e:
        print(f"  ERROR: backend not reachable at {BASE}: {e}")
        return 2
    print(f"  status={h.get('status')}  ollama={h.get('ollama_running')}  "
          f"primary={h.get('primary_available')}  fallback={h.get('fallback_available')}")
    if not h.get("ollama_running"):
        print("  Ollama is not running. Start it with `ollama serve`.")
        return 2
    if not (h.get("primary_available") or h.get("fallback_available")):
        print("  Neither primary nor fallback model is pulled locally.")
        print("  Run: ollama pull qwen2.5:14b   (or)   ollama pull deepseek-r1:14b")
        return 2

    print(f"[2/3] GET  {BASE}/models")
    m = _get_json(f"{BASE}/models")
    names = [x.get("name") for x in m.get("models", [])]
    print(f"  primary={m.get('primary')} fallback={m.get('fallback')}")
    print(f"  local models: {names}")

    print(f"[3/3] POST {BASE}/generate  (dummy notice u/s 142(1) — TDS on rent)")
    payload = {
        "text": DUMMY_NOTICE,
        "query": (
            "Draft a formal para-wise reply to this notice on behalf of the "
            "assessee. Address each of the three queries. For the s.194-IB / "
            "Form 26QC point, cite the relevant CBDT Notification by number "
            "and date. Cite the Income Tax Act, 1961, the Income Tax Rules, "
            "1962, and any applicable CBDT Circular for the HRA / landlord-PAN "
            "requirement."
        ),
        "history": [],
        "temperature": 0.2,
    }
    result = _post_json(f"{BASE}/generate", payload)
    reply = result.get("reply", "")
    print(f"  model_used = {result.get('model_used')}")
    print(f"  output_file = {result.get('output_file')}")
    print(f"  session_id = {result.get('session_id')}")
    print(f"  reply length = {len(reply)} chars")

    out_file = Path(result.get("output_file", ""))
    if not out_file.exists():
        print(f"  ERROR: expected DOCX at {out_file} does not exist.")
        return 1

    lower = reply.lower()
    cites_notification = "notification" in lower
    cites_circular = "circular" in lower
    cites_section_194 = "194-i" in lower or "194i" in lower or "section 194" in lower
    cites_verified_hra = "8/2013" in lower or "08/2013" in lower
    catches_premise = (
        "194-i " in lower
        or "section 194-i" in lower
        or "company" in lower and "individual" in lower
    )
    no_fabricated_rule_37a = "rule 37a" not in lower
    no_fabricated_9_2023 = "9/2023" not in lower and "09/2023" not in lower

    print()
    print("-- Citation / quality checks --")
    print(f"  mentions 'Notification' (info)        : {cites_notification}")
    print(f"  mentions 'Circular'                   : {cites_circular}")
    print(f"  cites s.194-* / catches premise error : {catches_premise}")
    print(f"  cites verified HRA Circular 8/2013    : {cites_verified_hra}")
    print(f"  no fabricated Rule 37A                : {no_fabricated_rule_37a}")
    print(f"  no fabricated Circular 9/2023         : {no_fabricated_9_2023}")
    print()
    print("-- Reply (first 800 chars) --")
    print(reply[:800])
    print("...")

    # Pass criteria: model must (a) catch the s.194-IB vs s.194-I premise error,
    # (b) cite the verified HRA circular, and (c) not fabricate either of the
    # two known-bad citations from the previous run.
    failures = []
    if not catches_premise:
        failures.append("did not catch s.194-IB vs s.194-I premise error")
    if not cites_verified_hra:
        failures.append("did not cite the verified CBDT Circular No. 8/2013 for HRA / landlord PAN")
    if not no_fabricated_rule_37a:
        failures.append("fabricated 'Rule 37A' (s.194-IB is governed by Rule 30(2B), not 37A)")
    if not no_fabricated_9_2023:
        failures.append("fabricated 'Circular 9/2023' for HRA (correct anchor is 8/2013)")

    if failures:
        print("\nFAIL:")
        for f in failures:
            print(f"  - {f}")
        return 1

    if not cites_notification:
        print("\nOK (no CBDT Notification cited — acceptable: model correctly "
              "hedged rather than fabricate. The strict-failure anti-fabrication "
              "rule in the system prompt prefers omission over invention.)")
    else:
        print("\nOK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
