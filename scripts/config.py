"""Shared constants for Grok Build mirror pipeline."""

from __future__ import annotations

# Official public artifact root (x.ai installer fallback CDN)
GCS_BASE = "https://storage.googleapis.com/grok-build-public-artifacts/cli"
# Optional primary (may be blocked in some regions)
XAI_BASE = "https://x.ai/cli"

# Channel file content is a plain version string, e.g. "1.0.0"
DEFAULT_CHANNEL = "stable"

# Platform artifact name suffixes after: grok-{version}-
# Windows keeps .exe; others have no extension on the CDN.
PLATFORMS: list[tuple[str, str]] = [
    ("windows-x86_64", "grok-{version}-windows-x86_64.exe"),
    ("linux-x86_64", "grok-{version}-linux-x86_64"),
    ("linux-aarch64", "grok-{version}-linux-aarch64"),
    ("macos-x86_64", "grok-{version}-macos-x86_64"),
    ("macos-aarch64", "grok-{version}-macos-aarch64"),
]

MIRROR_STATE_PATH = "mirror/latest.json"
ARTIFACTS_DIR = "artifacts"

# 123 Open Platform
PAN123_API = "https://open-api.123pan.com"
PAN123_ACCESS_TOKEN = f"{PAN123_API}/api/v1/access_token"
PAN123_MKDIR = f"{PAN123_API}/upload/v1/file/mkdir"
PAN123_LIST = f"{PAN123_API}/api/v2/file/list"
PAN123_CREATE = f"{PAN123_API}/upload/v2/file/create"
PAN123_COMPLETE = f"{PAN123_API}/upload/v2/file/upload_complete"
PAN123_SHA1_REUSE = f"{PAN123_API}/upload/v2/file/sha1_reuse"
