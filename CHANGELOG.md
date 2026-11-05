# Changelog

All notable changes to this project are listed here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## 1.0.0 - 2026-11-05

First public release. Earlier versions were not released.

### Added

- Mock Studio server (`npm run mock-studio`) for testing without Studio or hardware.
- Unit and end-to-end tests, CI, a release workflow and a packaging script.
- Documentation: wire protocol, privacy notice, security policy and contributing guide.

### Changed

- The extension moved to `extension/`. Select that folder when using **Load unpacked**.
- The site shortcuts in the popup are plain text links that open in a new tab, and they use generic URLs.
- The popup uses local CSS and makes no remote requests.
- Permissions reduced to `activeTab` and `scripting`.
- The popup's messages now explain connection failures, including pages where Chrome doesn't allow extensions and sites without local network access.

### Fixed

- Brightness and volume are restored when a session stops, on **Disconnect** and when the connection closes.
- The brightness filter no longer overwrites the page's other inline styles.
- Clicking **Connect** repeatedly no longer adds message listeners or leaves extra sockets open.
- `BROWSER_START_PLAYER` treats `progress` as a fraction of the media's length, not as seconds.
- Out-of-range and non-finite feedback values no longer cause errors. Values are clamped to 0..1.
- Malformed messages, unknown node indexes and pages with no media no longer cause errors.
- Media added to the page after connecting is reported to Studio, and the page's own media event handlers are left alone.
- The popup no longer reacts to connection messages from other tabs.

### Security

- `OPEN_URL` accepts only http and https URLs, and opens them with `noopener`.

### Removed

- Third-party logos from the popup.
- Unused files: vendored dependencies, jQuery, the background worker and test WebSocket scripts.
