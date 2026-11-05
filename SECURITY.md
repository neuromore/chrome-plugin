# Security

## Reporting a vulnerability

Please report vulnerabilities privately, not in a public issue:

- Use [GitHub private vulnerability reporting](https://github.com/neuromore/chrome-plugin/security/advisories/new), or
- Email contact@neuromore.com.

Include the steps to reproduce, the extension version and what an attacker could achieve. Fixes go into the latest release only.

Report vulnerabilities in Studio itself to the [Studio project](https://github.com/neuromore/studio).

## Threat model

The extension talks to `ws://127.0.0.1:4547` with no authentication or encryption, because Studio's WebSocket server offers neither. The extension can't tell Studio from any other program on that port.

**So any local process that holds the port can, for tabs the user has connected:**

- Change the tab's volume and brightness, including rapid brightness changes.
- Seek, play and pause the page's first video, and ask for fullscreen.
- Ask to open http and https URLs in new tabs.
- Read the tab's URL and the URLs of media playing in it. See [docs/PRIVACY.md](docs/PRIVACY.md).

**What limits this:**

- The extension connects only after the user clicks **Connect**, and only in that tab's top frame. It has no host permissions and no background worker.
- The address is fixed to the loopback interface. Studio can't redirect it.
- `OPEN_URL` accepts only http and https, so `javascript:`, `file:` and similar URLs are ignored. Links open with `noopener`.
- Volume and brightness are clamped to 0..1, and non-finite values are ignored.
- Malformed messages and unknown message types or node indexes are ignored. Messages are parsed as JSON or as a fixed binary layout and are never evaluated.
- The content script runs in Chrome's isolated world, so page scripts can't call its functions.
- The extension loads no remote code, and its popup uses only local files.
- When the session or connection ends, the page's original brightness and volume come back.

**What isn't mitigated:**

- A local process can do everything in the first list. Anyone who can already run programs on your computer is outside what this extension can defend against.
- Page scripts share the DOM with the content script, so they can read or change the media elements and styles it touches.
- Chrome's local network access permission applies to the site, not to the extension. A site you grant it to can try to connect to `127.0.0.1:4547` itself, and to other local addresses. Grant it only to sites you trust.
- Studio listens on all network interfaces, with no authentication, and its server code sets no origin check. Other computers on your network, or web pages that can reach it, may be able to connect to Studio. Use it on networks you trust, or restrict the port with a firewall.
