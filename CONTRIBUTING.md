# Contributing to quint-spec-skill

Thank you for your interest in improving the Quint Specification Skill!

## How to contribute

### Adding New Templates or Patterns

1.  Create a new markdown file in `skills/quint-spec/references/` or update an existing one.
2.  Follow the 9-phase workflow described in `SKILL.md`.
3.  Label Quint code fences:
    - `\`\`\`quint executable` for standalone snippets that should pass parser validation.
    - `\`\`\`quint illustrative` for conceptual or partial snippets.
4.  Validate snippets:

    ```bash
    # CI-equivalent validation (executable fences only)
    npm run validate:quint -- --strict-labels

    # Stronger executable validation (parse + type/effect checks)
    npm run validate:quint:typecheck

    # Ensure all reference markdown files are policy-declared and covered
    npm run validate:references

    # Deep audit: parse all Quint fences (executable + illustrative)
    npm run validate:quint:all
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

## Development Standards

- **Node.js**: Use Node.js >= 20.
- **Dependencies**: Run `npm ci` for reproducible installs.
- **Linting**: Run `npm run lint` before committing.
- **Formatting**: We use `prettier`. Run `npm run format` to auto-format your changes.
- **Quint runtime for tooling**: The repository pins `@informalsystems/quint` in `package.json` for deterministic checks.
- **Quint in user-facing docs**: Keep install instructions at `@latest` and rely on freshness automation to detect drift.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
