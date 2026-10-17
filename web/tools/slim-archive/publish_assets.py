#!/usr/bin/env python3
"""Publish the slim archive's parts as a git tag in the repository.

The page fetches each part over HTTPS, so the bytes have to live somewhere a
browser can reach.  A GitHub *release* is the obvious home, but its upload
endpoint (uploads.github.com) is not reachable from every network, while the
git data API (api.github.com) is.  So the parts are committed as blobs straight
through the API — no branch is touched, nothing large is written into the local
clone — and referenced by a lightweight tag:

    https://raw.githubusercontent.com/<owner>/<repo>/<tag>/parts/<name>

Usage:
    publish_assets.py --parts-dir /tmp/hkss/slim-parts --tag art-preserved-YYYYMMDD \
        [--repo owner/name] [--workers 4] [--dry-run]
"""
import argparse
import base64
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

API = "https://api.github.com"


def token():
    out = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True)
    if out.returncode:
        raise SystemExit("gh is not authenticated: " + out.stderr.strip())
    return out.stdout.strip()


def call(method, path, body=None, raw=False, method_headers=None, timeout=900):
    """One API call with curl (no extra dependencies, no request buffering)."""
    cmd = ["curl", "-sS", "-X", method, "-H", "Authorization: token " + token(),
           "-H", "Accept: application/vnd.github+json"]
    for h in (method_headers or []):
        cmd += ["-H", h]
    if body is not None:
        cmd += ["--data-binary", "@-"]
    cmd.append(API + path if path.startswith("/") else path)
    data = json.dumps(body).encode() if body is not None else None
    out = subprocess.run(cmd, input=data, capture_output=True, timeout=timeout)
    if out.returncode:
        raise SystemExit("curl failed: " + out.stderr.decode()[:400])
    text = out.stdout.decode()
    if raw:
        return text
    try:
        return json.loads(text)
    except ValueError:
        raise SystemExit("unexpected response: " + text[:400])


def create_blob(path, repo):
    with open(path, "rb") as fh:
        data = fh.read()
    body = json.dumps({"encoding": "base64",
                       "content": base64.b64encode(data).decode()})
    for attempt in range(4):
        cmd = ["curl", "-sS", "-X", "POST",
               "-H", "Authorization: token " + token(),
               "-H", "Accept: application/vnd.github+json",
               "--data-binary", "@-", API + "/repos/" + repo + "/git/blobs"]
        out = subprocess.run(cmd, input=body.encode(), capture_output=True, timeout=900)
        try:
            reply = json.loads(out.stdout.decode())
        except ValueError:
            reply = {}
        if "sha" in reply:
            return reply["sha"]
        time.sleep(2 * (attempt + 1))
    raise SystemExit("blob upload failed for %s: %s" % (path, out.stdout.decode()[:200]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--parts-dir", required=True)
    ap.add_argument("--tag", required=True,
                    help="new version tag (for example art-preserved-YYYYMMDD)")
    ap.add_argument("--repo", default="kinggerb/silksongcode")
    ap.add_argument("--prefix", default="parts")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    names = sorted((n for n in os.listdir(a.parts_dir) if n.startswith("WebGL.zip.part")),
                   key=lambda n: int(n.rsplit("part", 1)[1]))
    total = sum(os.path.getsize(os.path.join(a.parts_dir, n)) for n in names)
    print("%s: %d files, %.1f MiB" % (a.parts_dir, len(names), total / 1048576))
    if a.dry_run:
        for n in names[:5]:
            print("  would upload", n)
        return

    t0 = time.time()
    with ThreadPoolExecutor(max_workers=a.workers) as pool:
        shas = list(pool.map(lambda p: create_blob(p, a.repo), [os.path.join(a.parts_dir, n) for n in names]))
    print("blobs: %d in %.0fs" % (len(shas), time.time() - t0))

    tree = [{"path": "%s/%s" % (a.prefix, n), "mode": "100644", "type": "blob", "sha": s}
            for n, s in zip(names, shas)]
    tree_sha = call("POST", "/repos/%s/git/trees" % a.repo,
                    {"tree": tree})["sha"]
    commit = call("POST", "/repos/%s/git/commits" % a.repo,
                  {"message": "slim asset archive (%d parts, %.1f MiB)"
                              % (len(names), total / 1048576),
                   "tree": tree_sha, "parents": []})["sha"]
    print("tree %s, commit %s" % (tree_sha[:12], commit[:12]))

    existing = call("GET", "/repos/%s/git/ref/tags/%s" % (a.repo, a.tag), raw=True)
    if '"ref"' in existing:
        call("PATCH", "/repos/%s/git/refs/tags/%s" % (a.repo, a.tag),
             {"sha": commit, "force": True})
        print("tag %s moved" % a.tag)
    else:
        call("POST", "/repos/%s/git/refs" % a.repo,
             {"ref": "refs/tags/%s" % a.tag, "sha": commit})
        print("tag %s created" % a.tag)

    print("\nbase url: https://raw.githubusercontent.com/%s/%s/%s/"
          % (a.repo, a.tag, a.prefix))
    print("mirror:   https://cdn.jsdelivr.net/gh/%s@%s/%s/" % (a.repo, a.tag, a.prefix))
    print("pinned:   https://cdn.jsdelivr.net/gh/%s@%s/%s/" % (a.repo, commit, a.prefix))


if __name__ == "__main__":
    main()
