# AGENT.md

Instructions for AI agents working in this repo.

## Documentation sync (mandatory)

Whenever you create, change, or remove any functionality, you MUST also update:

1. `README.md` — top-level overview, feature list, usage examples.
2. `docs/docs/**` — the Docusaurus documentation site (matching page or new page if the feature is new).

Rules:

- Docs updates happen in the **same PR** as the code change. Never ship a feature PR without doc updates.
- If a feature is removed, remove its docs too — don't leave orphan pages.
- If a new feature has no obvious doc home, create a new page under the most relevant `docs/docs/` section and link it from the sidebar / index.
- Examples in docs must match current behavior (flags, config keys, CLI output).

This rule applies to every PR that changes user-visible behavior, CLI flags, config schema, commands, or public API.
