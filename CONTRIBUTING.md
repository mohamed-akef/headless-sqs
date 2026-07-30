# Contributing

Thanks for taking the time. Bug reports and small, focused pull requests are both welcome.

## Getting set up

```sh
npm install
npm run check
```

`npm run check` is what CI runs: format check, lint, type check, tests with coverage, and build. Run it before opening a pull request.

Individual steps:

| Command                     | Purpose                                 |
| --------------------------- | --------------------------------------- |
| `npm test`                  | Run the test suite                      |
| `npm run test:watch`        | Re-run tests on change                  |
| `npm run test:coverage`     | Tests with coverage thresholds enforced |
| `npm run typecheck`         | `tsc --noEmit`                          |
| `npm run lint` / `lint:fix` | ESLint with type-aware rules            |
| `npm run format`            | Prettier                                |
| `npm run build`             | Dual ESM + CJS build via tsup           |

Requires Node.js 22 or newer.

## Project layout

```
src/
  producer.ts            publishing
  consumer.ts            polling and acknowledgement
  errors.ts              typed error hierarchy
  logger.ts              logging interface
  types.ts               public option types
  internal/
    queue-name.ts        name validation and FIFO/DLQ naming
    attributes.ts        queue attribute building and validation
    queue-resolver.ts    URL resolution, caching and provisioning
    process-batch.ts     batch handling and ordering
```

Anything under `internal/` is private and may change without a major release. The public surface is whatever `src/index.ts` exports.

## Tests

Tests use [Vitest](https://vitest.dev) and [`aws-sdk-client-mock`](https://github.com/m-radzikowski/aws-sdk-client-mock); nothing talks to real AWS.

Two things worth knowing before you write one:

- **`aws-sdk-client-mock` reuses a single stub per command.** Calling `.on(SomeCommand)` again does not start a fresh call counter, so `rejectsOnce` maps to the stub's _first ever_ call. If you need a rejection after earlier calls have happened, `sqs.reset()` and set the behaviour up from scratch.
- **Consumer tests must stop what they start.** The shared `consumer()` helper registers each instance for teardown; a poller left running will keep the test process alive.

When fixing a bug, add a test that fails without the fix. Several tests carry a `// Regression:` comment describing the original defect — please keep that habit, since it is what stops a fix from quietly coming undone.

## Conventions

- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`), with `!` for a breaking change.
- Comments should explain _why_, not restate the code. Ones that pay for themselves usually record a constraint (an SQS limit, an ordering guarantee) or a decision someone would otherwise undo.
- Prefer failing early with a message naming the field and the accepted range over passing an invalid value to AWS.
- Do not add a runtime dependency without a good reason. `@aws-sdk/client-sqs` stays a peer dependency so applications control the version.

## Releasing

Releases are automatic. The version in `package.json` is the trigger — there are no tags to cut by hand.

Maintainers only:

1. Bump the version: `npm version <x.y.z> --no-git-tag-version` (keeps `package.json` and the lockfile in step).
2. Retitle the `CHANGELOG.md` entry from _Unreleased_ to the version and date.
3. Open a PR and merge it to `main`.

That is the whole process. On merge, the release workflow compares `package.json` against npm and, if that version is not published yet, runs the full check suite, publishes, then creates the tag and a GitHub release with the notes taken from the matching changelog section.

Because **npm is the source of truth** for what has been released, the workflow is safe to re-run: a version already on npm is skipped rather than erroring, and a run that failed partway can simply be re-run. Publishing happens _before_ tagging, so a failed publish leaves no tag to clean up.

### Publishing credentials

Publishing uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers): the workflow exchanges a GitHub OIDC token for short-lived npm credentials, so there is **no npm token stored in this repository** — nothing to leak or rotate. Provenance attestations are generated automatically, which is why the publish step does not pass `--provenance`.

Three things worth knowing before changing any of this:

- The trusted publisher on npm is bound to the **workflow filename**. Renaming `release.yml` breaks publishing until the npm configuration is updated to match.
- Trusted publishing needs npm >= 11.5.1, which is newer than the npm bundled with Node. The workflow upgrades npm and asserts the version, so a regression fails with a clear message rather than an opaque authentication error.
- If publishing fails with `404 Not Found - PUT`, npm has **no credentials** — it answers 404 rather than 403 so as not to reveal whether a package exists. It does not mean the package is missing. The workflow prints the exact trusted-publisher settings to fix it.
