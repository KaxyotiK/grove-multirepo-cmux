# Contributing to grove-multirepo-cmux

Use Node.js 24 or newer on macOS. Create a focused branch and run the full gate before opening a pull request:

```bash
npm install
npm run verify
```

`verify` typechecks, builds, runs the offline suites against a fake cmux, and checks that every acceptance criterion in [test/ACCEPTANCE.md](test/ACCEPTANCE.md) is named by at least one test. A change to behaviour should add or update the criterion and the test that proves it.

Changes to how grove-cmux talks to cmux should also pass the live suite against a real cmux in a disposable macOS VM. [scripts/tart/README.md](scripts/tart/README.md) describes building the VM and running `npm run test:live`.

grove-cmux does no git work of its own; Grove owns the repositories and Trees. Keep it that way: projection reads the Tree layout and drives cmux, nothing more.

Commit messages should describe the user-visible outcome. Report security vulnerabilities privately as described in the [security policy](SECURITY.md), not in public issues.
