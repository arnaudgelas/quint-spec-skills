# Contributing to quint-spec-skill

Thank you for your interest in improving the Quint Specification Skill!

## How to contribute

### Adding New Templates or Patterns

1.  Create a new markdown file in `skills/quint-spec/references/` or update an existing one.
2.  Follow the workflow described in `SKILL.md`.
3.  Label Quint code fences:
    - `\`\`\`quint executable` for standalone snippets that should pass parser validation.
    - `\`\`\`quint illustrative` for examples that must typecheck in CI, with a hidden preamble when context is required.
    - `\`\`\`quint sketch`for partial Quint fragments checked by the hard-error and scope gates. Files declaring`ci-all-fences` cannot contain sketches.
4.  Validate snippets:

    ```bash
    # Strict executable parser validation
    npm run validate:quint -- --strict-labels

    # Stronger executable validation (parse + type/effect checks)
    npm run validate:quint:typecheck

    # Ensure all reference markdown files are policy-declared and covered
    npm run validate:references

    # CI: parse and typecheck every executable and illustrative Quint fence
    npm run validate:quint:all
    npm run validate:quint:all:typecheck

    # CI: invariants, reachability witnesses, and progress for all runnable blocks
    npm run validate:quint:runtime
    ```

### Improving the Tooling

1.  Tooling scripts are located in `scripts/`.
2.  Update or add unit tests in `scripts/*.test.mjs`.
3.  Run tests:
    ```bash
    npm test
    ```

### Maintaining Freshness

The skill maintains its own references to upstream Quint and Apalache documentation. To check for drift:

```bash
npm run upstream:check
```

To update references:

```bash
npm run upstream:update
```

If npm latest has moved past the pinned `@informalsystems/quint` version, first run
`npm install --save-dev --save-exact @informalsystems/quint@<version>` and commit the package
and lockfile changes. The updater reads command inventory from the local pinned CLI.

## Development Standards

- **Node.js**: Use Node.js >= 20.18.1.
- **Dependencies**: Run `npm ci` for reproducible installs.
- **Linting**: Run `npm run lint` before committing.
- **Formatting**: We use `prettier`. Run `npm run format` to auto-format your changes.
- **Quint runtime for tooling**: The repository pins `@informalsystems/quint` in `package.json` for deterministic checks.
- **Quint in user-facing docs**: Pin the tested version exactly (currently `@informalsystems/quint@0.32.0`), consistent with the package and upstream snapshot. Upgrade deliberately after validation.
- **Apalache**: Quint 0.32.0 bundles Apalache 0.56.1; use Java 17 or newer for symbolic verification.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
