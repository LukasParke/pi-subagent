# Releasing

Pi installs packages from **npm** or **git**. Publishing binds both:

| Source | Install command | Needs |
|--------|-----------------|-------|
| npm | `pi install npm:@parke.dev/pi-subagent@0.3.1` | npm publish + `pi-package` keyword |
| git | `pi install git:github.com/LukasParke/pi-subagent@v0.3.1` | GitHub Release / tag |
| local | `pi install /path/to/pi-subagent` | checkout only |

The [pi.dev package gallery](https://pi.dev/packages) lists npm packages that declare the `pi-package` keyword (already set in `package.json`).

## One-time: npm Trusted Publishing

This repo’s [Release](../.github/workflows/release.yml) workflow is set up for
[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC).
No long-lived `NPM_TOKEN` is required or used.

### 1. Ensure the package exists on npm

Trusted Publisher settings live under the **package** page, and **npm cannot
create a brand-new package via OIDC** — the very first publish of a new name
must use a traditional auth path (interactive `npm publish` from a logged-in
maintainer, or a short-lived granular token). After that first publish,
configure the trusted publisher and revoke the token.

**Name notes:**

- unscoped `pi-subagent` is blocked by npm as too similar to the existing
  package [`pi-sub-agent`](https://www.npmjs.com/package/pi-sub-agent).
- This project publishes as **`@parke.dev/pi-subagent`** (the `parke.dev`
  npm org owns the scope).
- `@lukehagar/pi-subagent` (≤ 0.2.0) is the deprecated predecessor — see
  [Scope migration](#scope-migration-lukehagar--parkedev) below.

Bootstrap the new package once from a local checkout:

```bash
npm login            # as a member of the parke.dev org
npm run release:check
npm publish --access public --ignore-scripts
```

Confirm: https://www.npmjs.com/package/@parke.dev/pi-subagent

### 2. Add the trusted publisher

On https://www.npmjs.com/package/@parke.dev/pi-subagent → **Settings** → **Trusted Publisher**:

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

## Scope migration (`@lukehagar` → `@parke.dev`)

Versions ≤ 0.2.0 were published as `@lukehagar/pi-subagent`. npm scopes cannot
be renamed or transferred, so from 0.2.1 the package lives at
`@parke.dev/pi-subagent`. The old package stays on npm (existing installs keep
working) and is deprecated with a pointer:

```bash
npm deprecate @lukehagar/pi-subagent \
  "Moved to @parke.dev/pi-subagent — pi install npm:@parke.dev/pi-subagent"
```

Users migrate with:

```bash
pi remove @lukehagar/pi-subagent   # or edit Pi's package config
pi install npm:@parke.dev/pi-subagent
```

## Install after publish

```bash
# npm (gallery / versioned)
pi install npm:@parke.dev/pi-subagent@0.3.1

# latest npm
pi install npm:@parke.dev/pi-subagent

# git pin to the release tag
pi install git:github.com/LukasParke/pi-subagent@v0.3.1

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
