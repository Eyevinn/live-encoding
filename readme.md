<h1 align="center">
  Eyevinn Live Encoding
</h1>

<div align="center">
  Open Source Live Encoder based on ffmpeg and Shaka packager. 
  <br />
  <br />
  :book: <b><a href="https://docs.osaas.io/">Available as a Service</a></b> :eyes:
  <br />
</div>

<div align="center">
<br />

[![PRs welcome](https://img.shields.io/badge/PRs-welcome-ff69b4.svg?style=flat-square)](https://github.com/Eyevinn/live-encoding/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22)
[![made with hearth by Eyevinn](https://img.shields.io/badge/made%20with%20%E2%99%A5%20by-Eyevinn-59cbe8.svg?style=flat-square)](https://github.com/Eyevinn)
[![Slack](http://slack.streamingtech.se/badge.svg)](http://slack.streamingtech.se)

[![Badge OSC](https://img.shields.io/badge/Evaluate-24243B?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTIiIGZpbGw9InVybCgjcGFpbnQwX2xpbmVhcl8yODIxXzMxNjcyKSIvPgo8Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSI3IiBzdHJva2U9ImJsYWNrIiBzdHJva2Utd2lkdGg9IjIiLz4KPGRlZnM%2BCjxsaW5lYXJHcmFkaWVudCBpZD0icGFpbnQwX2xpbmVhcl8yODIxXzMxNjcyIiB4MT0iMTIiIHkxPSIwIiB4Mj0iMTIiIHkyPSIyNCIgZ3JhZGllbnRVbml0cz0idXNlclNwYWNlT25Vc2UiPgo8c3RvcCBzdG9wLWNvbG9yPSIjQzE4M0ZGIi8%2BCjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iIzREQzlGRiIvPgo8L2xpbmVhckdyYWRpZW50Pgo8L2RlZnM%2BCjwvc3ZnPgo%3D)](https://app.osaas.io/browse/eyevinn-live-encoding)

</div>

Live transcoding to HLS and optionally MPEG-DASH. Provides origin for CDN shield to pull streams as well as push to CDN origin.

![Screenshot 1](screenshot1.png)
![Screenshot 2](screenshot2.png)

[![Badge OSC](https://img.shields.io/badge/Evaluate-24243B?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTIiIGZpbGw9InVybCgjcGFpbnQwX2xpbmVhcl8yODIxXzMxNjcyKSIvPgo8Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSI3IiBzdHJva2U9ImJsYWNrIiBzdHJva2Utd2lkdGg9IjIiLz4KPGRlZnM%2BCjxsaW5lYXJHcmFkaWVudCBpZD0icGFpbnQwX2xpbmVhcl8yODIxXzMxNjcyIiB4MT0iMTIiIHkxPSIwIiB4Mj0iMTIiIHkyPSIyNCIgZ3JhZGllbnRVbml0cz0idXNlclNwYWNlT25Vc2UiPgo8c3RvcCBzdG9wLWNvbG9yPSIjQzE4M0ZGIi8%2BCjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iIzREQzlGRiIvPgo8L2xpbmVhckdyYWRpZW50Pgo8L2RlZnM%2BCjwvc3ZnPgo%3D)](https://app.osaas.io/browse/eyevinn-live-encoding)

## Requirements

- ffmpeg and optionally Shaka packager installed

## Installation / Usage

```
% npm install
```

### Environment Variables

| Variable             | Description                                                                                                                                                                                                                | Default value                |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `PORT`               | API port to bind and listen to                                                                                                                                                                                             | `8000`                       |
| `ORIGIN_DIR`         | Location on disk where to write media segments and playlists                                                                                                                                                               | `/tmp/media`                 |
| `HLS_ONLY`           | Only output HLS + TS                                                                                                                                                                                                       | `true`                       |
| `RTMP_PORT`          | RTMP port to bind and listen to                                                                                                                                                                                            | `1935`                       |
| `STREAM_KEY`         | RTMP streamkey                                                                                                                                                                                                             | `stream`                     |
| `INPUT_URL`          | Optional `srt://` input URL. If set, the encoder dials this source in caller mode instead of listening for an RTMP publisher. If not set the RTMP listener is used                                                         |                              |
| `INPUT_DIAL_TIMEOUT` | Caller-mode dial deadline in seconds. If the source is never reached within this bound the encoder gives up and goes to `error`. A per-request `timeout` overrides it                                                      | `300`                        |
| `OUTPUT_URL`         | URL to upload media segments and playlists. If not set push to CDN is disabled                                                                                                                                             |                              |
| `LADDER`             | ABR ladder as a comma-separated list of video rungs, each `<width>x<height>:<bitrate>`, e.g. `1920x1080:5000k,1280x720:2800k,640x360:800k`. An invalid value fails startup. If not set the built-in default ladder is used | `1280x720:4M,640x360:3M`     |
| `FRAMERATE`          | Output framerate as a positive integer (typically `25`, `30`, `50` or `60`). Each rung is converted to this rate and the GOP is set to 2 x framerate. If not set the output follows the input framerate                    | input framerate              |
| `SUBTITLE_URL`       | Sidecar WebVTT source URL fetched alongside the A/V input. If not set the output stays video+audio only                                                                                                                    |                              |
| `SUBTITLE_LANGUAGE`  | BCP-47 language tag for the subtitle rendition, e.g. `en`                                                                                                                                                                  | `und`                        |
| `SUBTITLE_NAME`      | Display name for the subtitle rendition, e.g. `English`                                                                                                                                                                    | value of `SUBTITLE_LANGUAGE` |
| `SUBTITLE_DEFAULT`   | Whether the subtitle rendition is the default (`true`/`1`)                                                                                                                                                                 | `false`                      |

### Subtitles

When `SUBTITLE_URL` is set to an `http(s)` WebVTT source, the encoder fetches it alongside the A/V input (RTMP listener or SRT caller) and publishes it as a segmented WebVTT rendition referenced from the HLS master playlist as an `#EXT-X-MEDIA:TYPE=SUBTITLES` group, available across the whole ABR ladder.

```
% ORIGIN_DIR=/data \
  SUBTITLE_URL=https://example.com/subtitles/en.vtt \
  SUBTITLE_LANGUAGE=en \
  SUBTITLE_NAME=English \
  SUBTITLE_DEFAULT=true \
  npm start
```

### ABR ladder and framerate

The ABR ladder and the output framerate are configurable through the environment. Both are optional: with neither set the encoder emits its built-in default ladder at the input framerate, exactly as before.

Set `LADDER` to a comma-separated list of video rungs, each `<width>x<height>:<bitrate>`:

```
% ORIGIN_DIR=/data \
  LADDER='1920x1080:5000k,1280x720:2800k,640x360:800k' \
  npm start
```

The bitrate of each rung is passed to ffmpeg verbatim, so an integer with an optional `k`/`M`/`G` suffix is accepted (`5000k`, `5M`, `5000000`). An invalid `LADDER` value fails startup with an error naming the offending entry: the encoder never silently falls back to the default ladder, because an operator who set `LADDER` expects that exact ladder and a quietly-different stream is harder to diagnose than a startup crash. Audio is not configurable through `LADDER` today; the default stereo AAC rung is always appended.

Set `FRAMERATE` to a positive integer to convert every rung to that framerate:

```
% ORIGIN_DIR=/data \
  LADDER='1280x720:2800k,640x360:800k' \
  FRAMERATE=50 \
  npm start
```

With `FRAMERATE` set, the keyframe interval (GOP) is derived as 2 x framerate so segments stay keyframe-aligned at a ~2 s cadence. With `FRAMERATE` unset the output follows the input framerate and the GOP stays at the fixed default of 48, so setting `LADDER` alone does not change the framerate or GOP.

### CDN Pull

Run encoder with media dir at `/data`

```
% ORIGIN_DIR=/data npm start
```

### SRT input (caller mode)

By default the encoder listens for an incoming RTMP publisher. Set `INPUT_URL` to an `srt://` URL to make the encoder dial a listener-mode SRT source in caller mode and pull the feed instead. This is useful for SRT contribution and for container platforms where no inbound UDP port can be exposed.

```
% ORIGIN_DIR=/data \
  INPUT_URL='srt://<host>:<port>?latency=200000&passphrase=<secret>&streamid=<id>' \
  npm start
```

Protocol knobs such as `latency` (microseconds), `passphrase`, `streamid` and `connect_timeout` (milliseconds) travel as query parameters on the URL and are handled by ffmpeg's srt reader directly, so any option the ffmpeg build supports can be used. While `INPUT_URL` is set the encoder stays in `starting` and retries the connection if the source is not up yet. It gives up and goes to `error` once the dial deadline is reached: the per-request `timeout` if supplied, otherwise `INPUT_DIAL_TIMEOUT` (default 300 seconds).

### User Interface

Web user interface available at `http://localhost:8000/`

### API

Start encoder:

```
% curl -X 'POST' \
  'http://localhost:8000/api/encoder' \
  -H 'accept: application/json' \
  -H 'Content-Type: application/json' \
  -d '{
  "timeout": 0
}'
```

Get status:

```
% curl -X 'GET' \
  'http://localhost:8000/api/encoder' \
  -H 'accept: application/json'
```

If status is `starting` you can start pushing to the RTMP address `rtmp://<your-host-ip>:1935/live/stream` (where `stream` is the streamkey).

When status is `running` you can play the HLS from `http://localhost:8000/origin/hls/index.m3u8`

Top stop the encoder:

```
% curl -X 'DELETE' \
  'http://localhost:8000/api/encoder' \
  -H 'accept: application/json'
```

### CDN Push (AWS Media Package)

Run encoder with media dir at `/data`

```
% ORIGIN_DIR=/data \
  OUTPUT_URL=https://<username>>:<password>@xxxxx.mediapackage.xxxx.amazonaws.com/in/v2/e82a0fc53d4b44ec89ac1a1fccd3a333/e82a0fc53d4b44ec89ac1a1fccd3a333/channel \
  npm start
```

### Docker

Run Eyevinn live encoding as a Docker container where `/tmp/media` is a directory on your host.

```
% docker run --rm -d \
  -p 8000:8000 -p 1935:1935 \
  -v /tmp/media:/data \
  eyevinntechnology/live-encoding
```

## Development

Start the API in development mode that restart server if file changes.

```
% DEBUG=1 npm run dev
```

API is then available at http://localhost:8000/api

Start the web application in development mode

```
% npm run dev:app
```

Then the web application is available at http://localhost:3000/ and will connect to the API on port 8000.

To then build the app run:

```
% npm run build:app
```

The output is placed in the folder `out/` that is then served by the server.

## Contributing

See [CONTRIBUTING](CONTRIBUTING.md)

## License

This project is licensed under the MIT License, see [LICENSE](LICENSE).

# Support

Join our [community on Slack](http://slack.streamingtech.se) where you can post any questions regarding any of our open source projects. Eyevinn's consulting business can also offer you:

- Further development of this component
- Customization and integration of this component into your platform
- Support and maintenance agreement

Contact [sales@eyevinn.se](mailto:sales@eyevinn.se) if you are interested.

# About Eyevinn Technology

[Eyevinn Technology](https://www.eyevinntechnology.se) is an independent consultant firm specialized in video and streaming. Independent in a way that we are not commercially tied to any platform or technology vendor. As our way to innovate and push the industry forward we develop proof-of-concepts and tools. The things we learn and the code we write we share with the industry in [blogs](https://dev.to/video) and by open sourcing the code we have written.

Want to know more about Eyevinn and how it is to work here. Contact us at work@eyevinn.se!
