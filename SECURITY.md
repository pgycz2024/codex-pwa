# Security policy

Codex PWA can execute commands and expose files with the permissions of the Linux user running it. Treat it as a remote administration interface, not as an ordinary static website.

## Required deployment boundaries

- Give every person a separate Linux account, Codex login, daemon, PWA process, port, password, and allowed root.
- Keep the Node service on `127.0.0.1`. Expose it only through a private-network socket proxy or a trusted HTTPS reverse proxy.
- Never expose the PWA or an unauthenticated app-server socket directly to the public Internet.
- Keep `CODEX_PWA_ROOTS` limited to directories that belong to that user.
- Use a separate high TCP port for each user's private-network listener.
- Enable systemd linger only for the intended Linux account.

## Files that must never be committed

- API keys, access tokens, `~/.codex/auth.json`, or other Codex credentials
- `~/.config/codex-pwa/access-password`
- `~/.config/codex-pwa/access-username`
- `~/.config/codex-pwa/trusted-devices.json`
- generated `.env` files, logs, uploaded private data, or rollout/session files

## Publishing from a shared server

- Do not sign a personal GitHub account into the shared Linux server.
- Do not store a personal GitHub token or account-wide SSH key on the server.
- Do not publish the development repository's `.git` directory; deleted private values can remain in historical objects.
- The safest default is to build the sanitized ZIP and clean one-commit Git bundle, download them over the existing SSH connection, and push to GitHub from the maintainer's own computer.
- Automated publishing may use a dedicated write-enabled Deploy Key limited to exactly one repository. Never reuse a personal SSH identity or place the key in a global agent.
- Keep the GitHub checkout separate from the development repository. Only synchronize the already-sanitized ZIP snapshot with `scripts/publish-mirror.sh`; never attach a GitHub remote to private development history.
- Pin GitHub host keys, bind the Deploy Key through the mirror's local `core.sshCommand`, require atomic non-force pushes, and revoke the key immediately if the server account is compromised.

## Public repository boundary

The public GitHub repository contains only the sanitized application source, documentation, tests, and release metadata. It does not contain server tasks, project files, Codex credentials, Web UI passwords, trusted-device cookies, logs, or the private development repository history. Reading or cloning the public repository does not grant access to the Linux server.

Each user's real security boundary is still the Linux account, file permissions, Codex credentials, private-network membership, PWA login credentials, and allowed root. A public repository must never be treated as a replacement for those controls.

The installer stores PWA configuration under `~/.config/codex-pwa` with restrictive permissions. Changing the PWA password invalidates previously trusted devices.

## Reporting

For an internal deployment, report security issues privately to the repository owner or server administrator. Do not include real credentials, task transcripts, or private server paths in a public issue.
