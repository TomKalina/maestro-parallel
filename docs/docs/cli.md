---
title: CLI reference
---

# CLI reference

```
maestro-parallel [path]                Run flows from [path] (default: .maestro)
maestro-parallel setup-ios-sim         Disable AutoFill on every booted sim
```

## Flags

| Flag | Description |
|---|---|
| `-c, --config <path>` | Path to config file. Default: auto-discover `maestroparallel.config.{ts,mts,js,mjs,cjs,json}`. |
| `--all` | Run on every discovered device (skip the picker). |
| `--skip-build` | Don't build or install; use whatever is already on each device. Useful for iterating on flow YAML against a stable build. |
| `--skip-clear` | Skip `pm clear` / sim data wipe before tests. |
| `--cwd <path>` | Project root. Default: current directory. |
| `--apple-team-id <ID>` | 10-character Apple Developer Team ID. Required for physical iOS. Overrides config + `MAESTRO_APPLE_TEAM_ID` env. |
| `-h, --help` | Show help. |
| `-v, --version` | Show version. |

## Environment

| Env var | Description |
|---|---|
| `MAESTRO_APPLE_TEAM_ID` | Apple Developer Team ID. Used when neither `--apple-team-id` nor config field is set. |
| Project's host env | Passed through to build child + Maestro. |

## Examples

```bash
# Auto-detect everything, prompt for device pick
maestro-parallel

# Every device, no picker
maestro-parallel --all

# Re-run flows without rebuilding
maestro-parallel --skip-build .maestro/login.yaml

# Explicit config
maestro-parallel --config ./e2e.config.ts

# CI runs (no TTY) — use --all so picker doesn't block
maestro-parallel --all --apple-team-id MTHKX3U9QF
```

## Exit codes

- `0` — every selected device passed.
- `1` — at least one device failed (build, install, or Maestro flow).
- `130` — SIGINT received (Ctrl-C).
