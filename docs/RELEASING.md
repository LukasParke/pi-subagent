# Releasing

Pi installs packages from **npm** or **git**. Publishing binds both:

| Source | Install command | Needs |
|--------|-----------------|-------|
| npm | `pi install npm:@lukehagar/pi-subagent@0.2.0` | npm publish + `pi-package` keyword |
| git | `pi install git:github.com/LukasParke/pi-subagent@v0.2.0` | GitHub Release / tag |
| local | `pi install /path/to/pi-subagent` | checkout only |

The [pi.dev package gallery](https://pi.dev/packages) lists npm packages that declare the `pi-package` keyword (already set in `package.json`).

## One-time: npm Trusted Publishing

This repo’s [Release](../.github/workflows/release.yml) workflow is set up for
[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC).
No long-lived `NPM_TOKEN` is required or used.

### 1. Ensure the package exists on npm

Trusted Publisher settings live under the **package** page.

**Name note:** unscoped `pi-subagent` is blocked by npm as too similar to the
existing package [`pi-sub-agent`](https://www.npmjs.com/package/pi-sub-agent).
This project publishes as **`@lukehagar/pi-subagent`** instead.

Confirm after first publish: https://www.npmjs.com/package/@lukehagar/pi-subagent

### 2. Add the trusted publisher

On https://www.npmjs.com/package/pi-subagent → **Settings** → **Trusted Publisher**:

| Field | Value |
|-------|-------|
| Provider | **GitHub Actions** |
| Organization or user | `LukasParke` |
| Repository | `pi-subagent` |
| Workflow filename | `release.yml` |
| Environment name | *(leave empty)* |
| Allowed actions | **`npm publish`** (required) |

Notes:

- Workflow filename is **only** `release.yml` — not `.github/workflows/release.yml`
- Values are case-sensitive
- npm does **not** validate this form until you actually publish
- Self-hosted runners are not supported (this workflow uses `ubuntu-latest`)

### 3. Optional hardening (after first successful OIDC publish)

Package → **Settings** → **Publishing access**:

- Select **Require two-factor authentication and disallow tokens**

This blocks classic tokens while Trusted Publishing continues to work.

### 4. GitHub Actions token scope for Releases

The workflow requests `contents: write` so it can create GitHub Releases.
If release creation fails with a permissions error, set:

**Repo → Settings → Actions → General → Workflow permissions → Read and write**

(OIDC publish uses `id-token: write`, which does not need that toggle.)

## Cut a release

1. Bump `version` in `package.json` if needed and commit to `main`.
2. Ensure CI is green:
   ```bash
   npm run release:check
   ```
3. Tag and push (tag **must** match `package.json`, with a leading `v`):
   ```bash
   VERSION=$(node -p "require('./package.json').version")
   git tag "v${VERSION}"
   git push origin main "v${VERSION}"
   ```
4. GitHub Actions **Release** will:
   - run typecheck + tests + pack dry-run
   - verify `vX.Y.Z` == `package.json` version
   - create a GitHub Release with the packed tarball
   - publish to npm via Trusted Publishing (automatic provenance)

Watch the run:

```bash
gh run list --workflow release.yml --limit 3
gh run watch
```

## Install after publish

```bash
# npm (gallery / versioned)
pi install npm:@lukehagar/pi-subagent@0.2.0

# latest npm
pi install npm:@lukehagar/pi-subagent

# git pin to the release tag
pi install git:github.com/LukasParke/pi-subagent@v0.2.0

# live main (not a release pin)
pi install git:github.com/LukasParke/pi-subagent
```

Then start Pi. The package registers the `subagent` tool and `/subagents` command.

## Troubleshooting Trusted Publishing

| Symptom | Check |
|---------|--------|
| `ENEEDAUTH` / Unable to authenticate | Workflow filename is exactly `release.yml`; org/user/repo match; allowed action includes `npm publish` |
| `ENEEDAUTH` after adding token secret | This workflow uses **OIDC only** and unsets `NODE_AUTH_TOKEN`. Remove blank secrets that might inject empty tokens |
| Provenance missing | Public repo + public package + Trusted Publishing path |
| GitHub Release fails | Workflow permissions need `contents: write` |
| Tag rejected by version check | `v0.1.0` tag requires `"version": "0.1.0"` in `package.json` |
| npm version too old | Workflow pins Node 24; step fails if npm < 11.5.1 |

## Package contract (Pi)

- `keywords` includes `pi-package` for gallery listing
- `pi.extensions` points at `./extensions/subagent.ts`
- Peer deps (`@earendil-works/pi-*`, `typebox`) are **not** bundled; Pi provides them
- `files` includes `extensions/`, `src/`, and `docs/`
- `repository.url` is `git+https://github.com/LukasParke/pi-subagent.git` (must match origin)
