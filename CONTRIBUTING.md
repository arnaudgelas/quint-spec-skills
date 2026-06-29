# Contributing to quint-spec-skill

Thank you for your interest in improving the Quint Specification Skill!

## How to contribute

### Adding New Templates or Patterns

1.  Create a new markdown file in `skills/quint-spec/references/` or update an existing one.
2.  Follow the workflow described in `SKILL.md`.
3.  Label Quint code fences:
    - `\`\`\`quint executable` for standalone snippets that should pass parser validation.
    - `\`\`\`quint illustrative` for self-contained examples that should typecheck in the deep audit.
    - `\`\`\`quint sketch` for partial Quint fragments that are counted but intentionally not typechecked.
4.  Validate snippets:

    ```bash
    # CI-equivalent validation (executable fences only)
    npm run validate:quint -- --strict-labels

    # Stronger executable validation (parse + type/effect checks)
    npm run validate:quint:typecheck

    # Ensure all reference markdown files are policy-declared and covered
    npm run validate:references

    # Deep audit: parse all executable and illustrative Quint fences
    npm run validate:quint:all

    # Runtime smoke for executable snippets that define init and step
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
`npm install --save-dev @informalsystems/quint@<latest>` and commit the package
and lockfile changes. The updater reads command inventory from the local pinned CLI.

## Development Standards

- **Node.js**: Use Node.js >= 20.18.1.
- **Dependencies**: Run `npm ci` for reproducible installs.
- **Linting**: Run `npm run lint` before committing.
- **Formatting**: We use `prettier`. Run `npm run format` to auto-format your changes.
- **Quint runtime for tooling**: The repository pins `@informalsystems/quint` in `package.json` for deterministic checks.
- **Quint in user-facing docs**: Keep install instructions at `@latest` and rely on freshness automation to detect drift.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
