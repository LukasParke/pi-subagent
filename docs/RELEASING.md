# Releasing

Pi installs packages from **npm** or **git**. Publishing this package binds both:

| Source | Install command | Needs |
|--------|-----------------|-------|
| npm | `pi install npm:pi-subagent@0.1.0` | npm publish + `pi-package` keyword |
| git | `pi install git:github.com/LukasParke/pi-subagent@v0.1.0` | GitHub Release / tag |
| local | `pi install /path/to/pi-subagent` | checkout only |

The [pi.dev package gallery](https://pi.dev/packages) lists npm packages that declare the `pi-package` keyword (already set in `package.json`).

## One-time npm setup

Pick **one** auth method for the Release workflow:

### Option A — Trusted Publishing (preferred)

1. Create the empty package once (first publish can also create it):
   - Log into https://www.npmjs.com/
   - Ensure the package name `pi-subagent` is available under your account
2. On the package settings page, add a **Trusted Publisher**:
   - Provider: GitHub Actions
   - Repository: `LukasParke/pi-subagent`
   - Workflow: `release.yml`
   - Environment: leave empty unless you add one
3. No long-lived `NPM_TOKEN` is required. The workflow already requests
   `id-token: write` and runs `npm publish --provenance`.

### Option B — Automation token

1. Create an npm **Automation** or granular access token with publish rights
2. Add it as a repository secret:
   ```bash
   gh secret set NPM_TOKEN --repo LukasParke/pi-subagent
   ```
3. Re-run or push a new release tag

## Cut a release

1. Bump `version` in `package.json` (and commit).
2. Ensure `main` is clean and CI is green:
   ```bash
   npm run release:check
   ```
3. Tag and push (tag **must** match `package.json`, with a leading `v`):
   ```bash
   VERSION=$(node -p "require('./package.json').version")
   git tag "v${VERSION}"
   git push origin main "v${VERSION}"
   ```
4. GitHub Actions [Release](../.github/workflows/release.yml) will:
   - run typecheck + tests + pack dry-run
   - verify `vX.Y.Z` == `package.json` version
   - create a GitHub Release with the packed tarball
   - publish to npm with provenance

## Install after publish

```bash
# npm (gallery / versioned)
pi install npm:pi-subagent@0.1.0

# latest npm
pi install npm:pi-subagent

# git pin to the release tag
pi install git:github.com/LukasParke/pi-subagent@v0.1.0

# live main (not a release pin)
pi install git:github.com/LukasParke/pi-subagent
```

Then start Pi. The package registers the `subagent` tool and `/subagents` command.

## Notes

- Package resources are declared via the `pi` key in `package.json` (`extensions/subagent.ts`).
- Peer deps (`@earendil-works/pi-*`, `typebox`) are not bundled; Pi already provides them.
- `files` includes `extensions/`, `src/`, and `docs/` so install and gallery consumers get the full package.
- Prefer git tags for permanent pins in team settings; use unscoped `npm:pi-subagent` only when you intentionally want npm update semantics.
