#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash scripts/publish-mirror.sh --mirror PATH --push

Publish the current tagged release through a separate, sanitized Git mirror.
The mirror must already be a clean checkout of origin/main and must use a
repository-scoped SSH identity through its local core.sshCommand setting.

Options:
  --mirror PATH  Existing sanitized GitHub mirror checkout
  --push         Required acknowledgement for the atomic branch/tag push
  -h, --help     Show this help
EOF
}

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
app_dir=$(cd -- "$script_dir/.." && pwd -P)
mirror=""
push_requested=0

while (($#)); do
  case "$1" in
    --mirror) mirror=${2:?missing mirror path}; shift 2 ;;
    --push) push_requested=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -n "$mirror" ]] || { printf '%s\n' '--mirror PATH is required.' >&2; exit 2; }
[[ "$push_requested" == "1" ]] || {
  printf '%s\n' 'Publishing changes remote state; rerun with --push after reviewing the release.' >&2
  exit 2
}

for command in git node npm rsync sha256sum unzip; do
  command -v "$command" >/dev/null 2>&1 || {
    printf '%s is required for sanitized mirror publishing.\n' "$command" >&2
    exit 1
  }
done

[[ -d "$mirror" && ! -L "$mirror" ]] || {
  printf 'Mirror must be an existing real directory: %s\n' "$mirror" >&2
  exit 2
}
mirror=$(cd -- "$mirror" && pwd -P)
if [[ "$mirror" == "$app_dir" || "$mirror" == "$app_dir/"* || "$app_dir" == "$mirror/"* ]]; then
  printf '%s\n' 'The sanitized mirror must be separate from the development checkout.' >&2
  exit 2
fi

cd -- "$app_dir"
[[ -z "$(git status --porcelain --untracked-files=all)" ]] || {
  printf '%s\n' 'Development checkout is not clean; commit the intended release first.' >&2
  exit 1
}
version=$(node -p 'require("./package.json").version')
tag="v$version"
head_commit=$(git rev-parse HEAD)
tag_commit=$(git rev-parse -q --verify "$tag^{commit}" 2>/dev/null || true)
[[ -n "$tag_commit" && "$tag_commit" == "$head_commit" ]] || {
  printf 'Tag %s must exist and point to the development HEAD.\n' "$tag" >&2
  exit 1
}

git -C "$mirror" rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  printf '%s\n' 'Mirror is not a Git checkout.' >&2
  exit 2
}
[[ "$(git -C "$mirror" branch --show-current)" == "main" ]] || {
  printf '%s\n' 'Mirror must be on its main branch.' >&2
  exit 1
}
[[ -z "$(git -C "$mirror" status --porcelain --untracked-files=all)" ]] || {
  printf '%s\n' 'Mirror checkout is not clean.' >&2
  exit 1
}
remote_url=$(git -C "$mirror" remote get-url origin)
[[ "$remote_url" =~ ^git@github\.com:[^/]+/[^/]+(\.git)?$ ]] || {
  printf '%s\n' 'Mirror origin must be an SSH GitHub repository URL.' >&2
  exit 1
}
ssh_command=$(git -C "$mirror" config --local --get core.sshCommand || true)
[[ "$ssh_command" == *"IdentitiesOnly=yes"* && "$ssh_command" == *"StrictHostKeyChecking=yes"* \
  && "$ssh_command" == *"UserKnownHostsFile="* && "$ssh_command" == *" -i "* ]] || {
  printf '%s\n' 'Mirror must locally pin a dedicated identity and strict known-hosts file.' >&2
  exit 1
}

git -C "$mirror" fetch --prune --tags origin
local_main=$(git -C "$mirror" rev-parse main)
remote_main=$(git -C "$mirror" rev-parse origin/main)
[[ "$local_main" == "$remote_main" ]] || {
  printf '%s\n' 'Mirror main is not exactly synchronized with origin/main.' >&2
  exit 1
}
if git -C "$mirror" show-ref --verify --quiet "refs/tags/$tag" \
  || git -C "$mirror" ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null 2>&1; then
  printf 'Release tag already exists in the sanitized publication history: %s\n' "$tag" >&2
  exit 1
fi

npm run release:local
archive="$app_dir/dist/codex-pwa-$tag.zip"
bundle="$app_dir/dist/codex-pwa-$tag-clean-git.bundle"
checksums="$app_dir/dist/SHA256SUMS-$tag.txt"
(
  cd -- "$app_dir/dist"
  sha256sum -c "$(basename -- "$checksums")"
)

stage=$(mktemp -d "${TMPDIR:-/tmp}/codex-pwa-publish.XXXXXX")
trap 'rm -rf -- "$stage"' EXIT
unzip -q "$archive" -d "$stage"
mapfile -t roots < <(find "$stage" -mindepth 1 -maxdepth 1 -type d -name "codex-pwa-$tag" -print)
[[ ${#roots[@]} -eq 1 ]] || {
  printf '%s\n' 'Release ZIP does not contain exactly one expected package root.' >&2
  exit 1
}
package_root=${roots[0]}
if find "$package_root" -type l -print -quit | grep -q .; then
  printf '%s\n' 'Release ZIP contains a symbolic link; refusing publication.' >&2
  exit 1
fi
(
  cd -- "$package_root"
  sha256sum -c RELEASE-MANIFEST.sha256
)

# Only the already-sanitized ZIP snapshot enters the public mirror. The
# publication mirror's .git directory and local SSH configuration are retained.
rsync -a --delete --exclude='/.git/' "$package_root/" "$mirror/"
git -C "$mirror" diff --check
git -C "$mirror" add -A
git -C "$mirror" diff --cached --check
if git -C "$mirror" diff --cached --quiet; then
  printf '%s\n' 'Sanitized snapshot contains no publication changes.' >&2
  exit 1
fi

git -C "$mirror" commit -m "Release Codex PWA $tag"
git -C "$mirror" tag -a "$tag" -m "Codex PWA $tag"
git -C "$mirror" push --atomic origin main "$tag"

published_main=$(git -C "$mirror" ls-remote origin refs/heads/main | awk '{print $1}')
published_tag=$(git -C "$mirror" ls-remote origin "refs/tags/$tag^{}" | awk '{print $1}')
[[ "$published_main" == "$(git -C "$mirror" rev-parse HEAD)" \
  && "$published_tag" == "$(git -C "$mirror" rev-parse "$tag^{commit}")" ]] || {
  printf '%s\n' 'Remote verification after the atomic push did not match.' >&2
  exit 1
}

printf 'Published sanitized %s to %s.\n' "$tag" "$remote_url"
printf 'GitHub Actions will test the tag and create the Release from the same snapshot.\n'
printf 'Local artifacts remain at:\n  %s\n  %s\n  %s\n' "$archive" "$bundle" "$checksums"
