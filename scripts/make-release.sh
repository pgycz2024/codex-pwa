#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
app_dir=$(cd -- "$script_dir/.." && pwd -P)
cd -- "$app_dir"

verify_only=0
candidate_only=0
if [[ $# -eq 1 && "$1" == "--verify-only" ]]; then
  verify_only=1
elif [[ $# -eq 1 && "$1" == "--candidate" ]]; then
  candidate_only=1
elif [[ $# -gt 0 ]]; then
  printf 'Usage: %s [--verify-only|--candidate]\n' "$(basename -- "$0")" >&2
  exit 2
fi

for required_command in git zip; do
  command -v "$required_command" >/dev/null 2>&1 || {
    printf '%s is required to create the distribution archive.\n' "$required_command" >&2
    exit 1
  }
done

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  printf 'Release builds must run from the maintained Git checkout.\n' >&2
  exit 1
fi
source_dirty=false
if [[ -n "$(git status --porcelain --untracked-files=all)" ]]; then source_dirty=true; fi
if (( ! verify_only && ! candidate_only )) && [[ "$source_dirty" == "true" ]]; then
  printf 'Release aborted: commit or remove all working-tree changes first.\n' >&2
  exit 1
fi

npm run check
version=$(node -p 'require("./package.json").version')
tag="v$version"
tag_commit=$(git rev-parse -q --verify "$tag^{commit}" 2>/dev/null || true)
head_commit=$(git rev-parse HEAD)
if (( ! verify_only && ! candidate_only )) && [[ -z "$tag_commit" || "$tag_commit" != "$head_commit" ]]; then
  printf 'Release aborted: tag %s must exist and point to HEAD.\n' "$tag" >&2
  exit 1
fi
stage=$(mktemp -d "${TMPDIR:-/tmp}/codex-pwa-release.XXXXXX")
trap 'rm -rf -- "$stage"' EXIT
package_root="$stage/codex-pwa-$tag"
mkdir -p -- "$package_root"

release_items=(
  .env.example .github .gitignore CHANGELOG.md LICENSE README.md SECURITY.md package.json package-lock.json
  app-server-bridge.mjs artifact-store.mjs auth-api.mjs auth-store.mjs directory-utils.mjs error-utils.mjs event-replay.mjs file-access.mjs file-api.mjs file-approval-context.mjs file-search.mjs protocol-adapter.mjs push-service.mjs root-access.mjs server.mjs sse-events.mjs static-server.mjs
  bounded-cache.mjs diagnostics-api.mjs task-api.mjs thread-artifacts.mjs thread-runtime.mjs thread-service.mjs
  thread-history.mjs thread-settings.mjs thread-mutation-queue.mjs task-recovery.mjs upload-utils.mjs
  docs public scripts systemd test
)
for item in "${release_items[@]}"; do
  [[ -e "$item" ]] || {
    printf 'Required release item is missing: %s\n' "$item" >&2
    exit 1
  }
  cp -a -- "$item" "$package_root/"
done

if find "$package_root" -type l -print -quit | grep -q .; then
  printf 'Release aborted: symbolic links are not allowed in the source package.\n' >&2
  exit 1
fi

node --experimental-vm-modules scripts/verify-release-modules.mjs "$package_root"

sensitive_patterns=(
  'OpenAI API key|sk-[A-Za-z0-9_-]{16,}'
  'GitHub token|(gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,})'
  'AWS access key|AKIA[0-9A-Z]{16}'
  'private key|-----BEGIN '"(RSA |EC |OPENSSH )?PRIVATE KEY"'-----'
  'personal deployment IP|172\.16\.2\.'"53"
  'personal home path|/home/'"dell"'(/|$)'
  'personal research path|第一篇'"论文"
  'personal server hostname|buntu'"server"
  'personal notification address|1239186037@'"qq\.com"
)
for entry in "${sensitive_patterns[@]}"; do
  label=${entry%%|*}
  pattern=${entry#*|}
  mapfile -t matches < <(grep -RIlE --binary-files=without-match --exclude='RELEASE-MANIFEST.sha256' \
    -e "$pattern" "$package_root" || true)
  if ((${#matches[@]})); then
    printf 'Release aborted: possible %s found in:\n' "$label" >&2
    printf '  %s\n' "${matches[@]}" >&2
    exit 1
  fi
done

(
  cd -- "$package_root"
  find . -type f ! -name RELEASE-MANIFEST.sha256 -print0 | sort -z | xargs -0 sha256sum > RELEASE-MANIFEST.sha256
)
node scripts/verify-release-manifest.mjs "$package_root"
node scripts/verify-release-runtime.mjs "$package_root"

if (( verify_only )); then
  printf 'Release verification passed: source integrity, privacy scan, module imports, and isolated package runtime are valid.\n'
  exit 0
fi

mkdir -p dist
if (( candidate_only )); then
  manifest_hash=$(sha256sum "$package_root/RELEASE-MANIFEST.sha256" | cut -d' ' -f1)
  candidate_dir=$(mktemp -d "$app_dir/dist/candidate-$tag-${manifest_hash:0:12}.XXXXXX")
  archive="$candidate_dir/codex-pwa-$tag-candidate.zip"
  (
    cd -- "$stage"
    zip -qr "$archive" "codex-pwa-$tag"
  )
  node --input-type=module - "$archive" "$package_root" "$head_commit" "$source_dirty" <<'NODE'
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
const [archive, root, sourceHead, sourceDirty] = process.argv.slice(2);
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const report = {
  kind: "local-candidate", published: false,
  version: JSON.parse(readFileSync(join(root, "package.json"))).version,
  sourceHead, sourceDirty: sourceDirty === "true",
  archive: basename(archive), archiveSha256: hash(archive),
  manifestSha256: hash(join(root, "RELEASE-MANIFEST.sha256")),
  serviceWorkerSha256: hash(join(root, "public/sw.js")),
};
const metadata = join(dirname(archive), "CANDIDATE.json");
writeFileSync(metadata, JSON.stringify(report, null, 2) + "\n");
writeFileSync(join(dirname(archive), "SHA256SUMS.txt"),
  `${report.archiveSha256}  ${basename(archive)}\n${hash(metadata)}  CANDIDATE.json\n`);
NODE
  printf 'Verified local candidate (not a release; package version unchanged):\n  %s\n  %s\n  %s\n' \
    "$archive" "$candidate_dir/CANDIDATE.json" "$candidate_dir/SHA256SUMS.txt"
  exit 0
fi
archive="$app_dir/dist/codex-pwa-$tag.zip"
bundle="$app_dir/dist/codex-pwa-$tag-clean-git.bundle"
checksums="$app_dir/dist/SHA256SUMS-$tag.txt"
rm -f -- "$archive" "$bundle" "$checksums"

# Build the Git bootstrap from the sanitized snapshot, never from this
# repository's development history. The resulting bundle has one generic
# initial commit and can be imported on Windows without GitHub credentials on
# the Linux server.
git -C "$package_root" init -q -b main
git -C "$package_root" config user.name "Codex PWA contributors"
git -C "$package_root" config user.email "codex-pwa@users.noreply.github.com"
git -C "$package_root" add -A
git -C "$package_root" commit -q -m "Initial release: Codex PWA $tag"
git -C "$package_root" tag -a "$tag" -m "Codex PWA $tag"
git -C "$package_root" bundle create "$bundle" HEAD main "$tag"
git -C "$package_root" bundle verify "$bundle" >/dev/null
rm -rf -- "$package_root/.git"

(
  cd -- "$stage"
  zip -qr "$archive" "codex-pwa-$tag"
)
(
  cd -- "$app_dir/dist"
  sha256sum "$(basename -- "$archive")" "$(basename -- "$bundle")" >"$(basename -- "$checksums")"
)
printf 'Created clean source distributions:\n  %s\n  %s\n  %s\n' "$archive" "$bundle" "$checksums"
printf 'The ZIP and clean Git bundle exclude development history, dependencies, credentials, logs, Codex sessions, and project data.\n'
