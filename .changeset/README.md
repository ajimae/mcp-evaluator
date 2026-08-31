# Changesets

This folder holds [changesets](https://github.com/changesets/changesets) — one Markdown file per
unreleased change, recording which version bump it needs and what to say about it in the changelog.

## Adding one

Run this alongside the change itself, so the reasoning is still fresh:

```sh
npm run changeset
```

It asks for a bump type and a summary, then writes a file here. Commit that file with your work.

- **patch** — bug fixes, docs, internal refactors with no API change
- **minor** — new config options, new exports, new CLI flags
- **major** — anything that breaks an existing config, export or CLI flag

The summary lands verbatim in `CHANGELOG.md`, so write it for someone upgrading: what changed and
what they have to do about it, not what the commit touched.

## Releasing

You do not run the release by hand. On a push to `master`, `.github/workflows/release.yml` collects
every changeset here and opens a **Version Packages** pull request that bumps the version and
rewrites the changelog. Merging that PR publishes to npm and deletes the consumed changesets.

No changesets pending means no release PR — the workflow simply does nothing.
