#!/usr/bin/env python3
"""Upload artifacts to 123 Cloud Disk (123pan).

Two auth modes:

1) **VIP / web login (default, what you want with only VIP)**  
   Secrets: ``PAN123_USERNAME`` + ``PAN123_PASSWORD``  
   (phone number or email + password — same as yun.123pan.com web login)

2) **Open Platform (needs developer membership)**  
   Secrets: ``PAN123_CLIENT_ID`` + ``PAN123_CLIENT_SECRET``

Env:
  PAN123_FOLDER      default GrokBuild
  PAN123_PARENT_ID   default 0 (root fileId)
  PAN123_MODE        auto | vip | open   (default auto)
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from pathlib import Path
from typing import Any

from config import ARTIFACTS_DIR

UA_WEB = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
)
LOGIN_API = "https://login.123pan.com/api/user/sign_in"
MAIN_API = "https://yun.123pan.com/b/api"
FILE_LIST = f"{MAIN_API}/file/list/new"
UPLOAD_REQUEST = f"{MAIN_API}/file/upload_request"
UPLOAD_COMPLETE = f"{MAIN_API}/file/upload_complete"
UPLOAD_COMPLETE_V2 = f"{MAIN_API}/file/upload_complete/v2"
S3_PRESIGN = f"{MAIN_API}/file/s3_repare_upload_parts_batch"
S3_AUTH = f"{MAIN_API}/file/s3_upload_object/auth"

# Open platform (optional)
OPEN_API = "https://open-api.123pan.com"
OPEN_TOKEN = f"{OPEN_API}/api/v1/access_token"
OPEN_MKDIR = f"{OPEN_API}/upload/v1/file/mkdir"
OPEN_LIST = f"{OPEN_API}/api/v2/file/list"
OPEN_CREATE = f"{OPEN_API}/upload/v2/file/create"
OPEN_COMPLETE = f"{OPEN_API}/upload/v2/file/upload_complete"

CHUNK = 16 * 1024 * 1024  # 16 MiB, same as OpenList web driver


class PanError(RuntimeError):
    pass


def md5_file(path: Path) -> str:
    h = hashlib.md5()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def md5_bytes(data: bytes) -> str:
    return hashlib.md5(data).hexdigest()


# ---------------------------------------------------------------------------
# VIP / web API
# ---------------------------------------------------------------------------


def sign_path(path: str, platform: str = "web", version: str = "3") -> tuple[str, str]:
    """Port of OpenList drivers/123 GetApi signPath."""
    table = b"adefghlmyijnopkqrstubcvwsz"
    rnd = f"{round(1e7 * random.random()):.0f}"
    # CST = UTC+8
    now = time.time() + 8 * 3600
    timestamp = str(int(time.time()))  # unix still real UTC epoch (Go uses now.Unix())
    # Go: time.Now().In(CST).Unix() — same as UTC unix; Format uses CST wall clock
    tm = time.gmtime(now)
    now_str = time.strftime("%Y%m%d%H%M", tm).encode("ascii")
    mapped = bytes(table[b - 48] for b in now_str)
    time_sign = str(zlib.crc32(mapped) & 0xFFFFFFFF)
    data = "|".join([timestamp, rnd, path, platform, version, time_sign])
    data_sign = str(zlib.crc32(data.encode("utf-8")) & 0xFFFFFFFF)
    return time_sign, f"{timestamp}-{rnd}-{data_sign}"


def with_sign(url: str) -> str:
    u = urllib.parse.urlparse(url)
    key, val = sign_path(u.path)
    q = urllib.parse.parse_qs(u.query, keep_blank_values=True)
    # flatten to list of pairs then add sign
    pairs = [(k, v) for k, vs in q.items() for v in vs]
    pairs.append((key, val))
    new_q = urllib.parse.urlencode(pairs)
    return urllib.parse.urlunparse((u.scheme, u.netloc, u.path, u.params, new_q, u.fragment))


class Pan123Vip:
    """Web login (phone/email + password). Works with normal VIP."""

    def __init__(self, username: str, password: str) -> None:
        self.username = username
        self.password = password
        self.token = ""
        self.platform = "web"

    def login(self) -> None:
        if "@" in self.username:
            body: dict[str, Any] = {
                "mail": self.username,
                "password": self.password,
                "type": 2,
            }
        else:
            body = {
                "passport": self.username,
                "password": self.password,
                "remember": True,
            }
        obj = self._raw_json(
            "POST",
            LOGIN_API,
            body=body,
            auth=False,
            signed=False,
            extra_headers={
                "origin": "https://yun.123pan.com",
                "referer": "https://yun.123pan.com/",
                "platform": "web",
                "app-version": "3",
            },
        )
        # login API uses code == 200
        if obj.get("code") != 200:
            raise PanError(f"login failed: {obj.get('message') or obj}")
        self.token = (obj.get("data") or {}).get("token") or ""
        if not self.token:
            raise PanError(f"login ok but empty token: {obj}")
        print("VIP login ok")

    def request(self, method: str, url: str, body: dict | None = None) -> dict:
        is_retry = False
        while True:
            obj = self._raw_json(method, url, body=body, auth=True, signed=True)
            code = obj.get("code")
            if code == 0:
                return obj
            if code == 401 and not is_retry:
                self.login()
                is_retry = True
                continue
            raise PanError(f"API {url}: {obj.get('message') or obj}")

    def _raw_json(
        self,
        method: str,
        url: str,
        *,
        body: dict | None,
        auth: bool,
        signed: bool,
        extra_headers: dict | None = None,
        timeout: int = 120,
        data: bytes | None = None,
        content_type: str | None = None,
    ) -> dict:
        hdrs = {
            "User-Agent": UA_WEB,
            "origin": "https://yun.123pan.com",
            "referer": "https://yun.123pan.com/",
            "platform": self.platform,
            "app-version": "3",
        }
        if extra_headers:
            hdrs.update(extra_headers)
        if auth:
            hdrs["authorization"] = f"Bearer {self.token}"
        payload: bytes | None = data
        if body is not None and data is None:
            payload = json.dumps(body).encode("utf-8")
            hdrs["Content-Type"] = "application/json"
        elif content_type:
            hdrs["Content-Type"] = content_type
        final_url = with_sign(url) if signed else url
        req = urllib.request.Request(final_url, data=payload, headers=hdrs, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as e:
            raw = e.read()
            raise PanError(f"HTTP {e.code} {url}: {raw[:400]!r}") from e
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as e:
            raise PanError(f"bad json from {url}: {raw[:200]!r}") from e

    def list_files(self, parent_id: int | str) -> list[dict]:
        page = 1
        out: list[dict] = []
        while True:
            q = urllib.parse.urlencode(
                {
                    "driveId": "0",
                    "limit": "100",
                    "next": "0",
                    "orderBy": "file_id",
                    "orderDirection": "desc",
                    "parentFileId": str(parent_id),
                    "trashed": "false",
                    "SearchData": "",
                    "Page": str(page),
                    "OnlyLookAbnormalFile": "0",
                    "event": "homeListFile",
                    "operateType": "4",
                    "inDirectSpace": "false",
                }
            )
            obj = self.request("GET", f"{FILE_LIST}?{q}")
            data = obj.get("data") or {}
            info = data.get("InfoList") or []
            out.extend(info)
            nxt = str(data.get("Next", "-1"))
            if not info or nxt == "-1":
                break
            page += 1
        return out

    def find_child(self, parent_id: int | str, name: str, want_dir: bool | None = None) -> dict | None:
        for item in self.list_files(parent_id):
            if item.get("FileName") != name:
                continue
            is_dir = int(item.get("Type", 0)) == 1
            if want_dir is True and not is_dir:
                continue
            if want_dir is False and is_dir:
                continue
            return item
        return None

    def mkdir(self, parent_id: int | str, name: str) -> int:
        hit = self.find_child(parent_id, name, want_dir=True)
        if hit:
            return int(hit["FileId"])
        self.request(
            "POST",
            UPLOAD_REQUEST,
            body={
                "driveId": 0,
                "etag": "",
                "fileName": name,
                "parentFileId": str(parent_id),
                "size": 0,
                "type": 1,
            },
        )
        for _ in range(15):
            hit = self.find_child(parent_id, name, want_dir=True)
            if hit:
                return int(hit["FileId"])
            time.sleep(0.4)
        raise PanError(f"mkdir failed to appear: {name}")

    def ensure_path(self, parent_id: int | str, parts: list[str]) -> int:
        cur: int | str = parent_id
        for part in parts:
            part = part.strip().strip("/")
            if not part:
                continue
            cur = self.mkdir(cur, part)
        return int(cur)

    def upload_file(self, parent_id: int | str, path: Path, remote_name: str | None = None) -> None:
        name = remote_name or path.name
        size = path.stat().st_size
        etag = md5_file(path)
        print(f"upload {name} size={size} md5={etag}")
        obj = self.request(
            "POST",
            UPLOAD_REQUEST,
            body={
                "driveId": 0,
                "duplicate": 2,  # keep both / rename style
                "etag": etag.lower(),
                "fileName": name,
                "parentFileId": str(parent_id),
                "size": size,
                "type": 0,
            },
        )
        data = obj.get("data") or {}
        if data.get("Reuse") or not data.get("Key"):
            print(f"  instant upload / reuse fileId={data.get('FileId')}")
            return

        file_id = data.get("FileId")
        # Path A: S3 session credentials (boto3)
        if data.get("AccessKeyId") and data.get("SecretAccessKey") and data.get("SessionToken"):
            self._upload_boto3(path, data)
            self.request("POST", UPLOAD_COMPLETE, body={"fileId": file_id})
            print(f"  completed (s3 creds) fileId={file_id}")
            return

        # Path B: presigned part URLs (no extra deps)
        self._upload_presigned(path, data)
        self.request(
            "POST",
            UPLOAD_COMPLETE_V2,
            body={
                "StorageNode": data.get("StorageNode"),
                "bucket": data.get("Bucket"),
                "fileId": file_id,
                "fileSize": size,
                "isMultipart": size > CHUNK,
                "key": data.get("Key"),
                "uploadId": data.get("UploadId"),
            },
        )
        print(f"  completed (presigned) fileId={file_id}")

    def _upload_presigned(self, path: Path, up: dict) -> None:
        size = path.stat().st_size
        chunk_count = max(1, math.ceil(size / CHUNK))
        print(f"  presigned parts={chunk_count}")

        def get_urls(start: int, end: int) -> dict[str, str]:
            # end is exclusive in OpenList loop: start..end-1 parts, API uses partNumberEnd exclusive? 
            # OpenList: partNumberStart=start, partNumberEnd=end where end = min(i+batch, chunkCount+1)
            api = S3_PRESIGN if chunk_count > 1 else S3_AUTH
            body = {
                "bucket": up["Bucket"],
                "key": up["Key"],
                "partNumberEnd": end,
                "partNumberStart": start,
                "uploadId": up["UploadId"],
                "StorageNode": up.get("StorageNode"),
            }
            resp = self.request("POST", api, body=body)
            urls = (resp.get("data") or {}).get("presignedUrls") or {}
            # keys may be str "1","2"
            return {str(k): v for k, v in urls.items()}

        batch = 10 if chunk_count > 1 else 1
        with path.open("rb") as f:
            part = 1
            while part <= chunk_count:
                start = part
                end = min(part + batch, chunk_count + 1)
                urls = get_urls(start, end)
                for cur in range(start, end):
                    cur_size = CHUNK if cur < chunk_count else (size - CHUNK * (chunk_count - 1))
                    # last part size when size % CHUNK == 0 is CHUNK
                    if cur == chunk_count:
                        cur_size = size - CHUNK * (chunk_count - 1)
                        if cur_size <= 0:
                            cur_size = CHUNK
                    data = f.read(cur_size)
                    if not data:
                        raise PanError(f"unexpected EOF at part {cur}")
                    url = urls.get(str(cur))
                    if not url:
                        raise PanError(f"missing presigned url part {cur}: {urls.keys()}")
                    self._put_bytes(url, data)
                    pct = cur * 100 // chunk_count
                    print(f"  part {cur}/{chunk_count} ({pct}%)")
                part = end

    def _put_bytes(self, url: str, data: bytes) -> None:
        req = urllib.request.Request(url, data=data, method="PUT")
        req.add_header("Content-Length", str(len(data)))
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=300) as resp:
                    if resp.status not in (200, 201, 204):
                        body = resp.read()
                        raise PanError(f"PUT status {resp.status}: {body[:200]!r}")
                    return
            except Exception as e:  # noqa: BLE001
                if attempt == 2:
                    raise PanError(f"PUT failed: {e}") from e
                time.sleep(2 * (attempt + 1))
                req = urllib.request.Request(url, data=data, method="PUT")
                req.add_header("Content-Length", str(len(data)))

    def _upload_boto3(self, path: Path, up: dict) -> None:
        try:
            import boto3
            from botocore.config import Config
        except ImportError as e:
            raise PanError(
                "this upload needs boto3 (pip install boto3). "
                "Or wait for server to return presigned-only mode."
            ) from e
        client = boto3.client(
            "s3",
            aws_access_key_id=up["AccessKeyId"],
            aws_secret_access_key=up["SecretAccessKey"],
            aws_session_token=up["SessionToken"],
            endpoint_url=up.get("EndPoint"),
            region_name="123pan",
            config=Config(s3={"addressing_style": "path"}, signature_version="s3v4"),
        )
        print("  uploading via boto3…")
        client.upload_file(str(path), up["Bucket"], up["Key"])


# ---------------------------------------------------------------------------
# Open platform (optional)
# ---------------------------------------------------------------------------


class Pan123Open:
    def __init__(self, client_id: str, client_secret: str) -> None:
        self.client_id = client_id
        self.client_secret = client_secret
        self.token = ""

    def login(self) -> None:
        obj = self._json(
            "POST",
            OPEN_TOKEN,
            body={"clientID": self.client_id, "clientSecret": self.client_secret},
            auth=False,
        )
        if obj.get("code") != 0:
            raise PanError(f"open token failed: {obj}")
        self.token = obj["data"]["accessToken"]
        print("Open platform login ok")

    def _json(
        self,
        method: str,
        url: str,
        body: dict | None = None,
        auth: bool = True,
        raw: bytes | None = None,
        content_type: str | None = None,
        timeout: int = 120,
    ) -> dict:
        hdrs = {"User-Agent": "grok-build-mirror/1.0", "Platform": "open_platform"}
        data = raw
        if body is not None and raw is None:
            data = json.dumps(body).encode("utf-8")
            hdrs["Content-Type"] = "application/json"
        elif content_type:
            hdrs["Content-Type"] = content_type
        if auth:
            hdrs["Authorization"] = f"Bearer {self.token}"
        req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def list_children(self, parent_id: int) -> list[dict]:
        last_id = 0
        out: list[dict] = []
        while last_id != -1:
            qs = f"?parentFileId={parent_id}&limit=100&lastFileId={last_id}&trashed=false"
            obj = self._json("GET", OPEN_LIST + qs)
            if obj.get("code") != 0:
                raise PanError(str(obj))
            data = obj.get("data") or {}
            for item in data.get("fileList") or []:
                if item.get("trashed", 0) == 0:
                    out.append(item)
            last_id = data.get("lastFileId", -1)
        return out

    def find_child(self, parent_id: int, name: str, is_dir: bool | None = None) -> dict | None:
        for item in self.list_children(parent_id):
            if item.get("filename") != name:
                continue
            if is_dir is True and item.get("type") != 1:
                continue
            if is_dir is False and item.get("type") == 1:
                continue
            return item
        return None

    def mkdir(self, parent_id: int, name: str) -> int:
        hit = self.find_child(parent_id, name, is_dir=True)
        if hit:
            return int(hit["fileId"])
        obj = self._json("POST", OPEN_MKDIR, body={"parentID": str(parent_id), "name": name})
        if obj.get("code") != 0:
            raise PanError(str(obj))
        for _ in range(10):
            hit = self.find_child(parent_id, name, is_dir=True)
            if hit:
                return int(hit["fileId"])
            time.sleep(0.4)
        raise PanError(f"mkdir not found: {name}")

    def ensure_path(self, parent_id: int, parts: list[str]) -> int:
        cur = parent_id
        for part in parts:
            part = part.strip("/")
            if part:
                cur = self.mkdir(cur, part)
        return cur

    def upload_file(self, parent_id: int, path: Path, remote_name: str | None = None) -> None:
        name = remote_name or path.name
        size = path.stat().st_size
        etag = md5_file(path)
        print(f"open create {name} size={size} md5={etag}")
        obj = self._json(
            "POST",
            OPEN_CREATE,
            body={
                "parentFileId": parent_id,
                "filename": name,
                "etag": etag.lower(),
                "size": size,
                "duplicate": 2,
                "containDir": False,
            },
        )
        if obj.get("code") != 0:
            raise PanError(str(obj))
        data = obj["data"]
        if data.get("reuse"):
            print(f"  reuse fileID={data.get('fileID')}")
            return
        preupload_id = data["preuploadID"]
        slice_size = int(data["sliceSize"])
        server = (data.get("servers") or [None])[0]
        if not server:
            raise PanError(f"no servers: {data}")
        server = server.rstrip("/")
        total = math.ceil(size / slice_size)
        with path.open("rb") as f:
            for i in range(total):
                chunk = f.read(slice_size)
                smd5 = md5_bytes(chunk)
                boundary = f"----Open{i}{smd5[:8]}"
                body = self._multipart(
                    boundary,
                    {
                        "preuploadID": preupload_id,
                        "sliceNo": str(i + 1),
                        "sliceMD5": smd5,
                    },
                    chunk,
                    f"{name}.part{i+1}",
                )
                ctype = f"multipart/form-data; boundary={boundary}"
                resp = self._json(
                    "POST",
                    f"{server}/upload/v2/file/slice",
                    raw=body,
                    content_type=ctype,
                    timeout=300,
                )
                if resp.get("code") != 0:
                    raise PanError(f"slice {i+1}: {resp}")
                print(f"  slice {i+1}/{total}")
        for _ in range(60):
            done = self._json("POST", OPEN_COMPLETE, body={"preuploadID": preupload_id})
            if done.get("code") == 0 and (done.get("data") or {}).get("completed"):
                print(f"  completed fileID={(done.get('data') or {}).get('fileID')}")
                return
            time.sleep(1)
        raise PanError("open complete timeout")

    @staticmethod
    def _multipart(boundary: str, fields: dict[str, str], file_bytes: bytes, filename: str) -> bytes:
        lines: list[bytes] = []
        for k, v in fields.items():
            lines.append(f"--{boundary}\r\n".encode())
            lines.append(f'Content-Disposition: form-data; name="{k}"\r\n\r\n'.encode())
            lines.append(v.encode())
            lines.append(b"\r\n")
        lines.append(f"--{boundary}\r\n".encode())
        lines.append(
            f'Content-Disposition: form-data; name="slice"; filename="{filename}"\r\n'
            f"Content-Type: application/octet-stream\r\n\r\n".encode()
        )
        lines.append(file_bytes)
        lines.append(b"\r\n")
        lines.append(f"--{boundary}--\r\n".encode())
        return b"".join(lines)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def detect_mode() -> str:
    mode = (os.environ.get("PAN123_MODE") or "auto").strip().lower()
    if mode in ("vip", "open"):
        return mode
    if os.environ.get("PAN123_USERNAME") and os.environ.get("PAN123_PASSWORD"):
        return "vip"
    if os.environ.get("PAN123_CLIENT_ID") and os.environ.get("PAN123_CLIENT_SECRET"):
        return "open"
    return "none"


def main() -> int:
    parser = argparse.ArgumentParser(description="Upload to 123pan (VIP login or Open API)")
    parser.add_argument("--dir", default=ARTIFACTS_DIR)
    parser.add_argument("--version", default="")
    parser.add_argument("--folder", default=os.environ.get("PAN123_FOLDER", "GrokBuild"))
    parser.add_argument("--parent-id", type=int, default=int(os.environ.get("PAN123_PARENT_ID") or "0"))
    args = parser.parse_args()

    mode = detect_mode()
    if mode == "none":
        print(
            "No 123 credentials. Set PAN123_USERNAME+PAN123_PASSWORD (VIP) "
            "or PAN123_CLIENT_ID+PAN123_CLIENT_SECRET (Open). Skip upload.",
            file=sys.stderr,
        )
        return 0

    art = Path(args.dir)
    manifest_path = art / "manifest.json"
    if not manifest_path.exists():
        raise SystemExit(f"missing {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("skipped"):
        print("manifest skipped; nothing to upload")
        return 0

    version = args.version or manifest.get("version") or "unknown"
    paths = [art / f["filename"] for f in manifest.get("files", [])]
    for extra in ("SHA256SUMS", "manifest.json"):
        p = art / extra
        if p.exists():
            paths.append(p)
    for p in paths:
        if not p.exists():
            raise SystemExit(f"missing {p}")

    parts = [x for x in args.folder.replace("\\", "/").split("/") if x]
    parts.append(str(version))

    if mode == "vip":
        client: Any = Pan123Vip(
            os.environ["PAN123_USERNAME"].strip(),
            os.environ["PAN123_PASSWORD"],
        )
        client.login()
        target = client.ensure_path(args.parent_id, parts)
    else:
        client = Pan123Open(
            os.environ["PAN123_CLIENT_ID"].strip(),
            os.environ["PAN123_CLIENT_SECRET"].strip(),
        )
        client.login()
        target = client.ensure_path(args.parent_id, parts)

    print(f"mode={mode} target_id={target} path={'/'.join(parts)}")
    for p in paths:
        client.upload_file(target, p)
    print("123pan upload done")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR: {exc}", file=sys.stderr)
        raise
