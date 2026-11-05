# Studio WebSocket protocol

How neuromore Studio and this extension talk to each other.

This document comes from reading [Studio's source](https://github.com/neuromore/studio) at commit [`17409bb`][commit], not from capturing traffic from a running Studio. `WebsocketProtocol.h` and `WebsocketServer.cpp` are identical at tag 1.7.3 and at that commit. The layout message, the port and the two node names were also checked at tag 1.7.0, and they are absent from 1.6.0. Line numbers refer to that commit.

## Transport

- Plain `ws://`, default port 4547 ([Config.h:111][config]). No TLS, subprotocol or authentication ([WebsocketServer.cpp:36-37][server-ctor]).
- Studio listens on all network interfaces ([WebsocketServer.cpp:60][server-listen]). The extension connects to `ws://127.0.0.1:4547`.
- Change the port in Studio under **Settings > Network > Websocket Server > Listen TCP Port** ([MainWindow.cpp:1425][mainwindow]).
- Every server message goes to all connected clients. Each tab with the extension connected is a separate client.
- There are no acknowledgements in either direction.

## JSON messages

JSON messages are text frames with this envelope ([WebsocketProtocol.h:82-86][envelope]):

```json
{ "header": { "type": "ON_SESSION_STOPPED" }, "data": {} }
```

Studio logs and drops a message if `header` or `data` is not an object, or `type` is not a string.

### Studio to extension

Values below are examples.

| Message                  | `data`                                | What the extension does                                                |
| ------------------------ | ------------------------------------- | ---------------------------------------------------------------------- |
| `ON_CLASSIFIER_LOADED`   | `{"name":"MyClassifier"}`             | Ignores it                                                             |
| `ON_STATEMACHINE_LOADED` | `{"name":"MyStateMachine"}`           | Ignores it                                                             |
| `ON_EXPERIENCE_LOADED`   | `{"name":"MyExperience"}`             | Ignores it                                                             |
| `ON_SESSION_STARTED`     | `{"start":"2015-10-31T09:15:32Z"}`    | Ignores it                                                             |
| `ON_SESSION_STOPPED`     | `{}`                                  | Restores the page                                                      |
| `ON_FEEDBACK_LAYOUT`     | See [below](#on_feedback_layout)      | Stores the node list                                                   |
| `OPEN_URL`               | `{"url":"https://example.com/"}`      | Opens http and https URLs in a new tab with `noopener`; ignores others |
| `BROWSER_START_PLAYER`   | `{"progress":0.5,"fullscreen":false}` | On the first `<video>`: seeks, optionally goes fullscreen, and plays   |
| `BROWSER_PAUSE_PLAYER`   | `{}`                                  | Pauses the first `<video>`                                             |
| `BROWSER_STOP_PLAYER`    | `{}`                                  | Ignores it                                                             |

`progress` is a fraction from 0.0 to 1.0, according to the attribute's description, minimum and maximum, although its label says "Progress (s)". Its default is 1.0, which is the end of the media ([Actions.cpp:781-784][actions-player]). No other client in Studio's source confirms this reading.

`OPEN_URL` and the `BROWSER_*_PLAYER` messages come from state machine actions ([Actions.cpp:767-770][actions-url]) and can arrive at any time.

### ON_FEEDBACK_LAYOUT

```json
{
  "header": { "type": "ON_FEEDBACK_LAYOUT" },
  "data": {
    "feedbacks": [
      { "name": "Volume Control", "sample_rate": 30.0, "channels": ["Sine"] },
      { "name": "Brightness Control", "sample_rate": 30.0, "channels": ["Sine"] }
    ]
  }
}
```

Source: [WebsocketProtocol.h:336-369][layout].

- `name` is the node's instance name. New nodes get their readable type as a name ([GraphWidget.cpp:1256][graphwidget]): `Volume Control` ([VolumeControlNode.h:87][volume]) or `Brightness Control` ([ScreenBrightnessNode.h:62][brightness]). Users can rename nodes, and the layout has no type field, so the name is the only way to identify a node. A Custom Feedback node named `Volume Control` also matches.
- `channels` lists the channel names on the node's first input port. For an unconnected node it is `[]`, and `sample_rate` is `0.0`.
- `sample_rate` comes from the node's signal resolution: the upstream rate, or 30.0, 10.0 or 4.0 ([OutputNode.cpp:305-314][sample-rate]). The extension doesn't use it.
- The array includes all feedback-class nodes: Custom Feedback, Volume, Brightness, Speed, Sun, Clouds, Fog, Rain and Vignette ([Classifier.cpp:438-446][classifier]). The extension ignores names it doesn't know.
- Studio sends the layout at session start and on connect during a session, and not when the classifier changes.

### Extension to Studio

| Message                     | `data`                                              | Sent when                                                  |
| --------------------------- | --------------------------------------------------- | ---------------------------------------------------------- |
| `ON_URL_OPENED`             | `{"url":"https://example.com/"}`                    | Once, when the socket opens                                |
| `ON_BROWSER_PLAYER_STARTED` | `{"media_id":"<currentSrc>","player_type":"video"}` | A media element plays. `player_type` is `video` or `audio` |
| `ON_BROWSER_PLAYER_PAUSED`  | `{"progress":0.42}`                                 | A media element pauses                                     |
| `ON_BROWSER_PLAYER_STOPPED` | `{"progress":1,"reason":"media_ended"}`             | A media element ends                                       |

Studio compares `url` exactly with the URLs in the state machine's conditions ([WebsocketServer.cpp:333][url-condition]). It reads no fields of the three player messages: they only set the matching state transition condition. All four have no effect without an active state machine.

Studio also accepts `IMPERSONATION`, which the extension never sends. It logs and ignores binary frames from clients ([WebsocketServer.cpp:157-161][binary-recv]) and messages of unknown types.

## Binary feedback frames

Studio sends feedback values as binary frames ([WebsocketProtocol.h:660-687][frame]):

| Offset | Type             | Field                                          |
| ------ | ---------------- | ---------------------------------------------- |
| 0      | uint16           | Type, always 1 (`CUSTOM_FEEDBACK`)             |
| 2      | uint16           | Index into `data.feedbacks` of the last layout |
| 4      | float64, N times | Values, where N is the node's channel count    |

- The length is 4 + 8N bytes, with N of at least 1. A node with no channels gets no frames but keeps its slot in the layout.
- Studio copies native memory without converting, which gives little-endian on the x86 and ARM targets it ships for. The extension reads little-endian.
- Every value in a frame is channel 0's current value, because `GetCurrentValue()` is called with no channel argument. Only the first value means anything.
- Studio sends one frame per node every 100 ms, whatever the node's sample rate, and only while a session is running ([WebsocketServer.cpp:274-296][frames-timer]).
- Values are raw last samples, with no clamping ([OutputNode.cpp:240-253][current-value]). They can be below 0, above 1, infinite or NaN. An out-of-range value only sets an error flag on the node. A node with no samples yet sends 0.0.

The extension clamps values to 0..1 and ignores non-finite ones. It ignores frames of the wrong length or type, and frames whose index isn't in the current layout.

Index 0, value 0.5 (12 bytes):

```
01 00 00 00 00 00 00 00 00 00 E0 3F
```

Index 1, value 0.25:

```
01 00 01 00 00 00 00 00 00 00 D0 3F
```

## Sequences

**On connect** ([WebsocketServer.cpp:93-105][on-connect]). Each message is sent only if it applies, in this order: `ON_CLASSIFIER_LOADED`, `ON_STATEMACHINE_LOADED`, `ON_EXPERIENCE_LOADED`, then, if a session is running, `ON_SESSION_STARTED` and `ON_FEEDBACK_LAYOUT`. If nothing is active, nothing is sent.

**Session start** ([WebsocketServer.cpp:165-175][session-start]). `ON_SESSION_STARTED`, `ON_FEEDBACK_LAYOUT`, then frames from the next 100 ms tick.

**Session stop** ([WebsocketServer.cpp:177-180][session-stop]). `ON_SESSION_STOPPED`, and frames stop.

## Mock server

[`tools/mock-studio.js`](../tools/mock-studio.js) implements this protocol for testing. Its header comment lists where it deliberately differs from Studio.

[commit]: https://github.com/neuromore/studio/tree/17409bb9e0e933f8a614ec9b85d45c7262d439ff
[config]: https://github.com/neuromore/studio/blob/17409bb9e0e933f8a614ec9b85d45c7262d439ff/src/Studio/Config.h#L111
[server-ctor]: https://github.com/neuromore/studio/blob/17409bb9e0e933f8a614ec9b85d45c7262d439ff/src/QtBase/Networking/WebsocketServer.cpp#L36-L37
[server-listen]: https://github.com/neuromore/studio/blob/17409bb9e0e933f8a614ec9b85d45c7262d439ff/src/QtBase/Networking/WebsocketServer.cpp#L60
[mainwindow]: https://github.com/neuromore/studio/blob/17409bb9e0e933f8a614ec9b85d45c7262d439ff/src/Studio/MainWindow.cpp#L1425
[envelope]: https://github.com/neuromore/studio/blob/17409bb9e0e933f8a614ec9b85d45c7262d439ff/src/Engine/Networking/WebsocketProtocol.h#L82-L86
[actions-player]: https://github.com/neuromore/studio/blob/17409bb9e0e933f8a614ec9b85d45c7262d439ff/src/Engine/Graph/Actions.cpp#L781-L784
[actions-url]: https://github.com/neuromore/studio/blob/17409bb9e0e933f8a614ec9b85d45c7262d439ff/src/Engine/Graph/Actions.cpp#L767-L770
[layout]: https://github.com/neuromore/studio/blob/17409bb9e0e933f8a614ec9b85d45c7262d439ff/src/Engine/Networking/WebsocketProtocol.h#L336-L369
[graphwidget]: https://github.com/neuromore/studio/blob/17409bb9e0e933f8a614ec9b85d45c7262d439ff/src/Studio/Plugins/Graph/GraphWidget.cpp#L1256
[volume]: https://github.com/neuromore/studio/blob/17409bb9e0e933f8a614ec9b85d45c7262d439ff/src/Engine/Graph/VolumeControlNode.h#L87
[brightness]: https://github.com/neuromore/studio/blob/17409bb9e0e933f8a614ec9b85d45c7262d439ff/src/Engine/Graph/ScreenBrightnessNode.h#L62
[sample-rate]: https://github.com/neuromore/studio/blob/17409bb9e0e933f8a614ec9b85d45c7262d439ff/src/Engine/Graph/OutputNode.cpp#L305-L314
[classifier]: https://github.com/neuromore/studio/blob/17409bb9e0e933f8a614ec9b85d45c7262d439ff/src/Engine/Graph/Classifier.cpp#L438-L446
[url-condition]: https://github.com/neuromore/studio/blob/17409bb9e0e933f8a614ec9b85d45c7262d439ff/src/QtBase/Networking/WebsocketServer.cpp#L333
[binary-recv]: https://github.com/neuromore/studio/blob/17409bb9e0e933f8a614ec9b85d45c7262d439ff/src/QtBase/Networking/WebsocketServer.cpp#L157-L161
[frame]: https://github.com/neuromore/studio/blob/17409bb9e0e933f8a614ec9b85d45c7262d439ff/src/Engine/Networking/WebsocketProtocol.h#L660-L687
[frames-timer]: https://github.com/neuromore/studio/blob/17409bb9e0e933f8a614ec9b85d45c7262d439ff/src/QtBase/Networking/WebsocketServer.cpp#L274-L296
[current-value]: https://github.com/neuromore/studio/blob/17409bb9e0e933f8a614ec9b85d45c7262d439ff/src/Engine/Graph/OutputNode.cpp#L240-L253
[on-connect]: https://github.com/neuromore/studio/blob/17409bb9e0e933f8a614ec9b85d45c7262d439ff/src/QtBase/Networking/WebsocketServer.cpp#L93-L105
[session-start]: https://github.com/neuromore/studio/blob/17409bb9e0e933f8a614ec9b85d45c7262d439ff/src/QtBase/Networking/WebsocketServer.cpp#L165-L175
[session-stop]: https://github.com/neuromore/studio/blob/17409bb9e0e933f8a614ec9b85d45c7262d439ff/src/QtBase/Networking/WebsocketServer.cpp#L177-L180
