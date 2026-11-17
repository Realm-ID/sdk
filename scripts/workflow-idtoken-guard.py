#!/usr/bin/env python3
"""Guard: a job that holds `id-token: write` installs nothing that can run code or float.

Rule. In any job whose effective permissions include `id-token: write`
(the job's own `permissions:` block, else the workflow's):
  * every `npm ci` / `npm install` carries `--ignore-scripts`;
  * every `npm install -g` / `npm i -g` names an EXACT version (`pkg@1.2.3`),
    never a range, a tag or a bare name.

Usage:
  scripts/workflow-idtoken-guard.py              # check .github/workflows
  scripts/workflow-idtoken-guard.py --self-test  # plant violations, require each is caught

Exit 0 = clean (or self-test passed), 1 = violation (or self-test did not fire),
2 = the checker could not run. The report states how many jobs it examined.
"""
import re
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    print("ERROR: PyYAML is required (pip install pyyaml)", file=sys.stderr)
    sys.exit(2)

ROOT = Path(__file__).resolve().parent.parent
NPM = re.compile(r"\bnpm\s+(ci|install|i|add)\b([^\n&;|)]*)")
EXACT = re.compile(r"^[@\w./-]+@\d+\.\d+\.\d+([-+][\w.]+)?$")


def holds_id_token(perms):
    return isinstance(perms, dict) and str(perms.get("id-token")) == "write"


def check_run(run):
    """Return the violation messages for one `run:` script."""
    out = []
    for m in NPM.finditer(run):
        verb, rest = m.group(1), m.group(2)
        args = rest.split("#")[0].split()
        is_global = "-g" in args or "--global" in args
        if is_global and verb != "ci":
            pkgs = [a for a in args if not a.startswith("-")]
            if not pkgs or not all(EXACT.match(p) for p in pkgs):
                out.append("npm install -g without an exact pinned version: " + m.group(0).strip())
        if not is_global and "--ignore-scripts" not in args:
            out.append("npm %s without --ignore-scripts: %s" % (verb, m.group(0).strip()))
    return out


def check_doc(doc, name):
    """Return (jobs_examined, violations) for one parsed workflow."""
    examined, bad = 0, []
    wf_perms = doc.get("permissions")
    for jid, job in (doc.get("jobs") or {}).items():
        if not isinstance(job, dict):
            continue
        perms = job["permissions"] if "permissions" in job else wf_perms
        if not holds_id_token(perms):
            continue
        examined += 1
        for i, step in enumerate(job.get("steps") or []):
            for msg in check_run(str(step.get("run", ""))):
                bad.append("%s: job %s step %d: %s" % (name, jid, i + 1, msg))
    return examined, bad


def check_dir(d):
    jobs, bad, files = 0, [], 0
    for f in sorted(list(d.glob("*.yml")) + list(d.glob("*.yaml"))):
        files += 1
        doc = yaml.safe_load(f.read_text())
        if not isinstance(doc, dict):
            continue
        n, b = check_doc(doc, f.name)
        jobs += n
        bad += b
    return files, jobs, bad


def self_test():
    wf = lambda perms, run: {"permissions": perms, "jobs": {"j": {"steps": [{"run": run}]}}}
    idt = {"id-token": "write"}
    must_fire = {
        "npm ci": wf(idt, "npm ci\nnpm run build"),
        "npm install": wf(idt, "npm install"),
        "npm ci chained": wf(idt, "cd x && npm ci && npm test"),
        "range": wf(idt, "npm install -g npm@>=11.5.1 --ignore-scripts"),
        "bare name": wf(idt, "npm install -g npm"),
        "tag": wf(idt, "npm i -g npm@latest"),
    }
    must_pass = {
        "ci ignore-scripts": wf(idt, "npm ci --ignore-scripts\nnpm run build"),
        "pinned global": wf(idt, "npm install -g npm@11.5.1"),
        "no id-token": wf({"contents": "read"}, "npm ci"),
        "job overrides": {"permissions": idt, "jobs": {"j": {"permissions": {"contents": "read"},
                                                           "steps": [{"run": "npm ci"}]}}},
    }
    ok = True
    for k, d in must_fire.items():
        if not check_doc(d, "t")[1]:
            print("SELF-TEST FAIL: did not fire: " + k)
            ok = False
    for k, d in must_pass.items():
        n, b = check_doc(d, "t")
        if b:
            print("SELF-TEST FAIL: false positive: %s %s" % (k, b))
            ok = False
    # positive control: the id-token job must be seen, or "clean" proves nothing
    if check_doc(must_pass["ci ignore-scripts"], "t")[0] != 1:
        print("SELF-TEST FAIL: id-token job not examined")
        ok = False
    print("self-test: %d must-fire, %d must-pass: %s" % (len(must_fire), len(must_pass), "ok" if ok else "FAILED"))
    return 0 if ok else 1


def main():
    if "--self-test" in sys.argv:
        return self_test()
    d = ROOT / ".github" / "workflows"
    if not d.is_dir():
        print("ERROR: no " + str(d), file=sys.stderr)
        return 2
    files, jobs, bad = check_dir(d)
    for b in bad:
        print("VIOLATION " + b)
    print("examined %d workflows, %d id-token jobs, %d violations" % (files, jobs, len(bad)))
    if jobs == 0:
        print("ERROR: no id-token job found; the guard examined nothing it guards", file=sys.stderr)
        return 2
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
