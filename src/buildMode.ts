// Build mode: how the app gets onto devices before flows run.
//
//   release — invoke the configured build hook to produce a real
//             production-style artifact, install it on the first device
//             of each platform group, and reuse-install on the rest.
//             This is the default whenever a hook is configured (either
//             explicitly or via auto-detection of Rock / EAS / Expo).
//             Rock-backed projects fingerprint the native dirs and
//             skip rebuilds on cache hits, so this is cheap when nothing
//             native changed.
//   skip    — assume the app is already installed; don't build or
//             install anything. Use when iterating on flow YAML against
//             a stable build. CLI: `--skip-build`.

export type BuildMode = 'release' | 'skip';
