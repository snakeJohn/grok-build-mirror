#!/usr/bin/env bash
# Create / update a GitHub Release from artifacts/ and commit mirror state.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ART="${ART:-artifacts}"
STATE="${STATE:-mirror/latest.json}"
MANIFEST="$ART/manifest.json"

if [[ ! -f "$MANIFEST" ]]; then
  echo "missing $MANIFEST" >&2
  exit 1
fi

if [[ -f "$ART/SKIP" ]] || jq -e '.skipped == true' "$MANIFEST" >/dev/null 2>&1; then
  echo "skip publish: already up to date"
  exit 0
fi

VERSION="$(jq -r .version "$MANIFEST")"
CHANNEL="$(jq -r .channel "$MANIFEST")"
TAG="grok-${VERSION}"
TITLE="Grok Build ${VERSION} (${CHANNEL})"

if [[ -z "${GITHUB_TOKEN:-}${GH_TOKEN:-}" ]]; then
  echo "GITHUB_TOKEN/GH_TOKEN required" >&2
  exit 1
fi

NOTES="$(
  cat <<EOF
Unofficial mirror of official public Grok Build CLI binaries.

- **Version:** \`${VERSION}\`
- **Channel:** \`${CHANNEL}\`
- **Source:** \`https://storage.googleapis.com/grok-build-public-artifacts/cli\`
- **Fetched at (UTC):** $(jq -r .fetched_at "$MANIFEST")

### Checksums (SHA-256)

\`\`\`
$(cat "$ART/SHA256SUMS")
\`\`\`

> This repository only redistributes publicly published artifacts for personal download convenience.
> Install / auth still go through official xAI endpoints when you run the client.
EOF
)"

# Create tag/release if missing; otherwise upload assets onto existing release.
if gh release view "$TAG" >/dev/null 2>&1; then
  echo "release $TAG exists; will re-upload assets"
  gh release edit "$TAG" --title "$TITLE" --notes "$NOTES"
else
  gh release create "$TAG" \
    --title "$TITLE" \
    --notes "$NOTES" \
    --latest
fi

# Upload binaries + checksums (clobber if re-run)
mapfile -t FILES < <(jq -r '.files[].filename' "$MANIFEST")
ASSETS=()
for f in "${FILES[@]}"; do
  ASSETS+=("$ART/$f")
done
ASSETS+=("$ART/SHA256SUMS" "$ART/manifest.json")

gh release upload "$TAG" "${ASSETS[@]}" --clobber

# Persist state in repo (small JSON only; no binaries in git)
mkdir -p "$(dirname "$STATE")"
cp "$MANIFEST" "$STATE"
# strip skipped field noise
jq 'del(.skipped)' "$STATE" >"$STATE.tmp" && mv "$STATE.tmp" "$STATE"

if [[ "${COMMIT_STATE:-1}" == "1" ]]; then
  git config user.name "${GIT_AUTHOR_NAME:-github-actions[bot]}"
  git config user.email "${GIT_AUTHOR_EMAIL:-41898282+github-actions[bot]@users.noreply.github.com}"
  git add "$STATE"
  if git diff --cached --quiet; then
    echo "state unchanged"
  else
    git commit -m "chore(mirror): sync Grok Build ${VERSION} (${CHANNEL})"
    git push
  fi
fi

echo "published release $TAG"
