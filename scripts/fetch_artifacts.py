#!/usr/bin/env python3
"""Download Grok Build CLI binaries from the public GCS bucket."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from config import (
    ARTIFACTS_DIR,
    DEFAULT_CHANNEL,
    GCS_BASE,
    MIRROR_STATE_PATH,
    PLATFORMS,
    XAI_BASE,
)

UA = "grok-build-mirror/1.0 (+https://github.com/)"


def http_get(url: str, timeout: int = 60) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def http_download(url: str, dest: Path, timeout: int = 600) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as resp, tmp.open("wb") as f:
        total = int(resp.headers.get("Content-Length") or 0)
        done = 0
        while True:
            chunk = resp.read(1024 * 1024)
            if not chunk:
                break
            f.write(chunk)
            done += len(chunk)
            if total:
                pct = done * 100 // total
                print(f"\r  {dest.name}: {done // (1024 * 1024)}MB / {total // (1024 * 1024)}MB ({pct}%)", end="", flush=True)
        print()
    tmp.replace(dest)


def fetch_version(channel: str) -> str:
    errors: list[str] = []
    for base in (GCS_BASE, XAI_BASE):
        url = f"{base}/{channel}"
        try:
            text = http_get(url, timeout=30).decode("utf-8").strip()
            if text and text[0].isdigit():
                print(f"version from {url}: {text}")
                return text
            errors.append(f"{url}: unexpected body {text!r}")
        except Exception as e:  # noqa: BLE001
            errors.append(f"{url}: {e}")
    raise RuntimeError("failed to resolve version:\n" + "\n".join(errors))


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def md5_file(path: Path) -> str:
    h = hashlib.md5()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def candidate_urls(version: str, filename: str) -> list[str]:
    return [
        f"{GCS_BASE}/{filename}",
        f"{XAI_BASE}/{filename}",
        # some historical names used darwin instead of macos
        f"{GCS_BASE}/{filename.replace('macos', 'darwin')}",
    ]


def download_platform(version: str, platform_key: str, filename: str, out_dir: Path) -> dict:
    dest = out_dir / filename
    last_err: Exception | None = None
    for url in candidate_urls(version, filename):
        print(f"trying {url}")
        try:
            http_download(url, dest)
            if dest.stat().st_size < 1_000_000:
                raise RuntimeError(f"file too small: {dest.stat().st_size} bytes from {url}")
            info = {
                "platform": platform_key,
                "filename": filename,
                "source_url": url,
                "size": dest.stat().st_size,
                "sha256": sha256_file(dest),
                "md5": md5_file(dest),
            }
            print(f"  ok size={info['size']} sha256={info['sha256'][:16]}...")
            return info
        except Exception as e:  # noqa: BLE001
            last_err = e
            print(f"  fail: {e}")
            if dest.exists():
                dest.unlink(missing_ok=True)
    raise RuntimeError(f"all mirrors failed for {filename}: {last_err}")


def load_state(path: Path) -> dict:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch Grok Build public artifacts")
    parser.add_argument("--channel", default=DEFAULT_CHANNEL, choices=["stable", "alpha", "enterprise"])
    parser.add_argument("--version", default="", help="pin version; empty = resolve from channel")
    parser.add_argument("--out", default=ARTIFACTS_DIR)
    parser.add_argument("--state", default=MIRROR_STATE_PATH)
    parser.add_argument("--force", action="store_true", help="download even if version unchanged")
    parser.add_argument("--platforms", default="all", help="comma list of platform keys, or all")
    args = parser.parse_args()

    version = args.version.strip() or fetch_version(args.channel)
    state_path = Path(args.state)
    prev = load_state(state_path)

    if not args.force and prev.get("version") == version and prev.get("channel") == args.channel:
        print(f"already mirrored {args.channel}={version}; skip (use --force to re-download)")
        # still write a marker for the workflow
        Path(args.out).mkdir(parents=True, exist_ok=True)
        (Path(args.out) / "SKIP").write_text("1\n", encoding="utf-8")
        (Path(args.out) / "manifest.json").write_text(
            json.dumps({**prev, "skipped": True}, indent=2) + "\n",
            encoding="utf-8",
        )
        return 0

    out_dir = Path(args.out)
    if out_dir.exists():
        for p in out_dir.iterdir():
            if p.is_file():
                p.unlink()
    out_dir.mkdir(parents=True, exist_ok=True)

    wanted = {k for k, _ in PLATFORMS} if args.platforms == "all" else {
        x.strip() for x in args.platforms.split(",") if x.strip()
    }

    files: list[dict] = []
    for platform_key, name_tpl in PLATFORMS:
        if platform_key not in wanted:
            continue
        filename = name_tpl.format(version=version)
        # retry a couple times for flaky CDN
        for attempt in range(1, 4):
            try:
                files.append(download_platform(version, platform_key, filename, out_dir))
                break
            except Exception as e:  # noqa: BLE001
                print(f"attempt {attempt} failed for {platform_key}: {e}")
                if attempt == 3:
                    raise
                time.sleep(3 * attempt)

    manifest = {
        "channel": args.channel,
        "version": version,
        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": GCS_BASE,
        "files": files,
        "skipped": False,
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    checksums = "\n".join(f"{f['sha256']}  {f['filename']}" for f in files) + "\n"
    (out_dir / "SHA256SUMS").write_text(checksums, encoding="utf-8")
    print(json.dumps({"version": version, "count": len(files)}, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR: {exc}", file=sys.stderr)
        raise
