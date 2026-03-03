# Maintenance

## Quint freshness policy

- Keep local references aligned with the upstream Quint CLI manual and npm package metadata.
- Keep Apalache JVM requirements aligned with the official installation docs.
- Avoid pinning static CLI defaults in markdown docs; prefer `quint <command> --help`.
- Keep executable snippets aligned with the pinned Quint tool version.

## Snippet policy

- `\`\`\`quint executable`: standalone snippets that must parse in CI.
- `\`\`\`quint illustrative`: conceptual snippets that may omit surrounding context.
- Unlabeled `\`\`\`quint` fences are not allowed in CI (`--strict-labels`).

## Dependency policy

- Repository tooling pins `@informalsystems/quint` to an exact version in `package.json`.
- User-facing install instructions remain `@latest` to keep the skill current for end users.
- Weekly drift workflow runs upstream freshness and reference-governance checks, then opens/updates an actionable issue on failures.
- `scripts/quint-upstream-check.mjs` treats command inventory discrepancies as drift unless explicitly allowlisted.

## Commands

```bash
# Validate local invariants only (no network)
node scripts/quint-upstream-check.mjs --offline

# Fetch upstream data and sync generated files
node scripts/quint-upstream-check.mjs --update

# Compare local generated files against upstream (network required)
node scripts/quint-upstream-check.mjs --check

# Validate executable snippets
node scripts/validate-quint-snippets.mjs --strict-labels

# Validate reference governance declarations
node scripts/validate-reference-governance.mjs
```

## Files maintained by the updater

- `skills/quint-spec/references/UPSTREAM.json`
- `skills/quint-spec/references/TOOLCHAIN.md` (`CLI Command Inventory` block)
- `skills/quint-spec/references/REFERENCE-GOVERNANCE.json`
