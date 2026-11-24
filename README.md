# Villavisión

A private virtual movie theatre you run on your own computer. Everyone you
invite watches the same movie at the same moment, wherever they are, and can
chat, react, talk and see each other while it plays.

- **In sync:** every viewer's player follows one shared clock, typically within
  a fraction of a second.
- **A theatre, not a video call:** a big screen, rows of seats, house lights
  that dim when the movie starts.
- **Social:** text chat, floating emoji reactions, voice chat and webcams.
- **Screen sharing:** Villavisión captures the host computer's screen itself and
  broadcasts it to the theatre, the way OBS does. No film is needed: you can
  open a theatre just for sharing.
- **One remote:** the host controls play, pause and skip, and can hand the
  remote to anyone.
- **Kind to slow connections:** movies are prepared in full quality plus a
  light version that players switch to automatically.
- **Private:** movies stay on your computer. Guests need the link you send.
- **No accounts:** guests open a link in their browser. Nothing to install.
- English and Spanish interface, chosen from each device's language.

> Use it for movies you have the right to share with the people you invite.

## What you need

| | |
|---|---|
| [Node.js](https://nodejs.org) 20.12 or newer | runs the theatre |
| [ffmpeg](https://ffmpeg.org) | prepares movies for streaming |
| [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (free, no account needed) | only to invite people outside your home |

```bash
# macOS
brew install node ffmpeg cloudflared
# Windows
winget install OpenJS.NodeJS ffmpeg Cloudflare.cloudflared
# Debian / Ubuntu (install cloudflared from the link above)
sudo apt install nodejs npm ffmpeg
```

## Quick start

```bash
git clone https://github.com/CydVilla/villavision.git
cd villavision
npm install
npm run online
```

The terminal prints two things:

1. **Your host page link.** Open it on this computer. It is private: it
   controls your theatres.
2. **Your public address**, something like `https://random-words.trycloudflare.com`.

Then, on the host page:

1. **Add a movie:** choose a video file. It is copied and prepared on your
   computer, which takes a while for a full-length movie; the page shows
   progress.
2. **Open a theatre** for that movie.
3. **Copy family link** and send it to your guests.
4. Click **Enter**. Entering from the host page is what makes you the host.

To try it alone first, `npm start` runs everything without going online.

## In the theatre

| Button | What it does | Who |
|---|---|---|
| ▶ / ⏸ and the timeline | Play, pause, skip for everyone | Host, and anyone holding the remote |
| 🖥️ | Share a screen or window on the big screen | Host |
| 🎤 📷 | Your microphone and webcam | Everyone |
| 🔊 CC ⛶ | Your own volume, subtitles, fullscreen | Everyone |
| 😂 ❤️ … | Reactions that float over the screen | Everyone |

- Click an empty seat to move there.
- Click a person to set how loud their voice is for you. The host also sees
  **Give the remote** there.
- Keyboard, for whoever holds the remote: space plays or pauses, the arrow
  keys skip 10 seconds.
- **Wear headphones if your microphone is on**, or the movie echoes back to
  everyone.

### Screen sharing

No film is needed: on the host page, **Screen sharing theatre** opens a
theatre with an empty big screen.

Villavisión captures the screen itself, on the computer that runs it, so only
the host can share. When the host clicks 🖥️ there, a small panel asks what to
share (a whole screen or one window) and which sound to send, then **Start
broadcast**. The theatre plays it as a live stream. Click 🖥️ again to stop; it
also stops if the host leaves the theatre or the shared window is closed.

- Everyone sees it about 6 seconds behind, and in sync with each other. Good
  for watching something together, slow for pointing at things as you talk.
- It works for any number of viewers and on phones, because it travels the
  same way the film does.
- **On a Mac** a small helper (`server/native/vv-capture.swift`) uses
  ScreenCaptureKit, the system framework OBS uses. It captures a single window
  even when other windows cover it, windows on other desktops, and the
  **computer's own sound** with no extra driver. Villavisión compiles the
  helper by itself the first time it starts; that needs Apple's command line
  tools (`xcode-select --install`). Without them you can still share whole
  screens, with a microphone or a virtual device such as
  [BlackHole](https://github.com/ExistentialAudio/BlackHole) for sound.
- **A browser tab** is shared by picking its browser window.
- **Sound:** "Computer sound" with a whole screen sends everything the computer
  plays, including the voices of people in the theatre, who then hear
  themselves a few seconds late. Share one window to send only that app's
  sound.
- **macOS permission:** allow Screen Recording for the app you start
  Villavisión from (Terminal, iTerm…) in System Settings → Privacy & Security.
  Without it the theatre says the capture was blocked.
- **Windows and Linux:** whole-desktop capture, one window by title on Windows
  (`gdigrab`), X11 only on Linux (`x11grab`). These commands are written but
  have not been run yet; only macOS is tested.
- Video protected by a streaming service shows as black, and their terms do
  not allow sharing it.

### Subtitles

Subtitles inside the movie file are found automatically, and so are `.srt` or
`.vtt` files next to it with the same name (`Movie.es.srt`) when you add the
movie from the terminal. Picture-based subtitles (DVD and Blu-ray style) cannot
be converted.

## How it works

```
server/room.js          one theatre: shared clock, seats, roles, chat, share state
server/index.js         web server, WebSocket endpoint, library, uploads
server/ingest.js        ffmpeg: movie file -> adaptive HLS + WebVTT subtitles
server/capture.js       this computer's screen or one window -> short live HLS stream
server/native/          macOS helpers, compiled on first start: screen capture, virtual machine
server/workspace.js     the shared computer (unfinished, off unless SHARED_COMPUTER=1): setup, start, stop
server/vm/user-data     what gets installed inside the shared computer
server/rfb.js           drops keys and clicks from people who may only watch it
server/deskaudio.js     passes the shared computer's sound and video stream on to the theatre
server/tunnel*.js       Cloudflare Tunnel (temporary or fixed address)
public/                 the theatre and host pages (plain HTML, CSS and JS)
test/                   tests for the theatre logic (npm test)
```

The server keeps one clock per theatre: "playing since time T from position P".
Each player measures its offset to the server's clock, works out where the
movie should be right now, and nudges its playback speed by a few percent to
stay there, jumping only when it is more than about a second off. Voice and
webcam use WebRTC between browsers; the server only relays their handshake
messages. A shared screen travels the way the film does, as a live stream from
the server.

## License

MIT. See [LICENSE](LICENSE).
