# Contributing

Bug reports and pull requests are welcome. Please follow the [Code of Conduct](CODE_OF_CONDUCT.md), and report vulnerabilities as described in [SECURITY.md](SECURITY.md), not in a public issue.

For a larger change, open an issue first so we can agree on the approach.

## Setup

You need [Node.js](https://nodejs.org) 26 (see `.nvmrc`) and Chrome or Chromium.

```sh
git clone https://github.com/neuromore/chrome-plugin.git
cd chrome-plugin
npm ci
npx playwright install chromium   # only for the end-to-end tests
```

## Layout

| Path         | Contents                                                                        |
| ------------ | ------------------------------------------------------------------------------- |
| `extension/` | The extension. Loaded as it is, with no build step. Only shipped files go here. |
| `test/unit/` | Unit tests, using jsdom and fake `chrome` and `WebSocket` objects.              |
| `test/e2e/`  | End-to-end tests in real Chromium against the mock server.                      |
| `tools/`     | The mock server and the packaging script.                                       |
| `docs/`      | The wire protocol, the privacy notice and images.                               |

## Scripts

| Command               | What it does                                                                           |
| --------------------- | -------------------------------------------------------------------------------------- |
| `npm test`            | Runs the unit tests.                                                                   |
| `npm run test:e2e`    | Runs the end-to-end tests. Port 4547 must be free, so close Studio and the mock.       |
| `npm run lint`        | Runs ESLint.                                                                           |
| `npm run format`      | Formats with Prettier. `npm run format:check` only checks.                             |
| `npm run mock-studio` | Starts the mock server. `-- --port <port>` listens on another port.                    |
| `npm run package`     | Builds `dist/neuromore-extension-<version>.zip`. Needs the `zip` and `unzip` commands. |

## Testing by hand with the mock

1. Close Studio, then run `npm run mock-studio`.
2. On `chrome://extensions`, turn on **Developer mode** and use **Load unpacked** to load `extension/`.
3. Open a page with audio or video, click the extension's icon and click **Connect**. The site may need the local network access permission: see the [README](README.md#local-network-access).
4. Volume and brightness should rise and fall. Type `stop` in the mock's terminal and check that the page goes back to how it was. Try `start`, `play 0.5`, `pause` and `url https://example.com/` too.

After you change the extension, click its reload button on `chrome://extensions` and reload your test tab. The content script from before the reload stays in the old tab and keeps its socket until then.

The mock was written from Studio's source and may differ from it. If your change depends on Studio's behaviour, test with real Studio too, and say in your pull request whether you did. The protocol is described in [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org): `fix: restore volume when the socket closes`, `docs: explain the port setting`. Common types are `feat`, `fix`, `docs`, `test`, `refactor`, `chore` and `ci`.

## Pull requests

- Keep each pull request to one change.
- Add or update tests for behaviour changes. A bug fix should have a test that fails without the fix.
- Run `npm run lint`, `npm run format:check`, `npm test` and `npm run test:e2e` before you submit. CI runs the same checks.
- Say how you tested it, including anything you couldn't test.
- Update the README, `docs/` and [CHANGELOG.md](CHANGELOG.md) when behaviour changes. Keep [docs/PRIVACY.md](docs/PRIVACY.md) accurate if you change what the extension sends.
- Avoid new manifest permissions, runtime dependencies and remote resources. If you need one, explain why in the pull request.

By contributing, you agree that your contribution is licensed under the [Apache License 2.0](LICENSE).

## Releases

Maintainers bump `version` in `extension/manifest.json` and `package.json`, run `npm install --package-lock-only`, update the changelog, and push a tag named `v<version>` on a `master` commit where CI passed, for example `v1.0.0`. The release workflow doesn't rerun the tests. It checks that the tag matches the manifest, then publishes the zip to GitHub Releases.
