# Privacy

The neuromore Chrome extension connects a browser tab to neuromore Studio on your own computer. It has no analytics, telemetry, ads or accounts, and its developers receive no data from it.

## What is sent

The extension does nothing until you click **Connect** in its popup, and then acts only on that tab. While the tab is connected, it sends the following to the WebSocket address `ws://127.0.0.1:4547`:

| Data                                                                          | When                                  |
| ----------------------------------------------------------------------------- | ------------------------------------- |
| The tab's full URL, including any query string and fragment                   | Once, when the connection opens       |
| The source URL of the audio or video element, and whether it's audio or video | When media starts playing on the page |
| The playback position, as a fraction of the media's length                    | When media pauses                     |
| The value 1 and the reason `media_ended`                                      | When media finishes                   |

URLs can contain personal information, such as search terms or access tokens in a query string.

## Where it goes

`127.0.0.1` is your own computer, so this data doesn't leave it over the network. The extension doesn't send anything to any other address.

The data goes to whichever program is listening on port 4547. Normally that's neuromore Studio, but the extension can't verify this. See [SECURITY.md](../SECURITY.md).

Reading Studio's source, Studio uses the tab's URL to compare it with the URLs in the active state machine, and doesn't read the other fields. What Studio does with data generally is covered by Studio's own terms, not by this document.

## What is received

Studio sends the extension feedback values, which it derives from your classifier and can be based on your EEG or other sensor data. The extension uses them to set the tab's volume and brightness and doesn't keep or forward them.

Because these changes are made on the page itself, the website's own scripts can read the current volume of its media elements and the filter on its page. A website could therefore observe the feedback values while a tab is connected.

If you allow a site local network access so that the extension can connect, Chrome also lets that site's own scripts try to connect to programs on your computer, including Studio.

## What isn't collected or stored

- The extension doesn't read page text, form fields, passwords, cookies or browsing history.
- It doesn't store anything: it uses no extension storage, cookies or local storage. Its state is lost when the page or browser closes.
- Its popup loads only files included in the extension. The site links in the popup go to those sites only if you click them.

## Contact

Questions: contact@neuromore.com.
