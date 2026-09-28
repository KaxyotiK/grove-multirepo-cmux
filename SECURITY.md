# Security policy

## Supported versions

Security fixes target the latest release of the `grove-multirepo-cmux` npm package and the `main` branch. Update with `npm install -g grove-multirepo-cmux@latest`.

## Reporting a vulnerability

Report suspected vulnerabilities through [GitHub's private vulnerability reporting](https://github.com/KaxyotiK/grove-multirepo-cmux/security/advisories/new). Include the affected commit or version, reproduction steps, and the expected impact. Keep exploit details and secrets out of public issues.

Reports are reviewed on a best-effort basis, with no guaranteed response or fix timeline.

## Trust boundary

grove-cmux runs as your macOS user and controls cmux only through the `cmux` command, which talks to cmux's control socket. It runs `cmux`, `git` and `grove` with argument arrays, never through a shell. The executables come from `PATH`, or from `GROVE_CMUX_CMUX_BIN` and `GROVE_BIN` in its own environment; nothing in a repository selects them.

A socket password, when cmux is in Password mode, comes only from `CMUX_SOCKET_PASSWORD` and is passed to `cmux` through its environment, not its arguments. The only file grove-cmux writes is the projection ledger at `<grove-root>/.grove-cmux/projection.json`.
