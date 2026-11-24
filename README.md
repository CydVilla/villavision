# Villavisión

A private virtual movie theatre you run on your own computer. Everyone you
invite watches the same movie at the same moment, wherever they are, and can
chat, react, talk and see each other while it plays.

- **In sync:** every viewer's player follows one shared clock, typically within
  a fraction of a second.
- **A theatre, not a video call:** a big screen, rows of seats, house lights
  that dim when the movie starts.
- **Social:** text chat, floating emoji reactions, voice chat and webcams.
- **Screen sharing:** put a window, a browser tab or your whole screen on the
  big screen, live.
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
| 🖥️ | Share your screen on the big screen | Host, and anyone holding the remote |
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

Click 🖥️ and pick what to show. The movie pauses and your screen takes over the
big screen until you stop.

- **Sound:** browsers can only capture sound from a *browser tab* (tick "Also
  share tab audio"), or from the whole screen on Windows and ChromeOS. On a Mac,
  share a tab if you need sound.
- It works from Chrome, Edge and Firefox on a computer. Phones can watch a
  share but cannot start one.
- Your screen is sent directly from your computer to each viewer, so your
  upload speed is shared between them. It suits a handful of viewers.
- Do not use this for streaming services: they block capture, and their terms
  do not allow it.

### Subtitles

Subtitles inside the movie file are found automatically, and so are `.srt` or
`.vtt` files next to it with the same name (`Movie.es.srt`) when you add the
movie from the terminal. Picture-based subtitles (DVD and Blu-ray style) cannot
be converted.

## A fixed address on your own domain

The quick-start address changes every time you start. If you manage a domain in
a free Cloudflare account, you can have a permanent one:

```bash
npm run tunnel:setup -- movies.example.com
```

It opens Cloudflare in your browser to sign in, creates a tunnel, and adds the
DNS record. From then on `npm run online` always uses `https://movies.example.com`.

## Adding movies from the terminal

```bash
npm run add -- "/path/to/Movie.mkv" "Movie Title"
```

`--audio=1` picks a different audio track (the tool lists them).
`--software` forces the slower software encoder on a Mac.

## Settings

Copy `.env.example` to `.env`. Everything is optional.

| Setting | Default | Purpose |
|---|---|---|
| `PORT` | `4747` | Port on this computer |
| `MEDIA_DIR` | `./media` | Where prepared movies are kept |
| `PUBLIC_URL` | | Your fixed public address |
| `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL` | | Relay for voice, webcam and screen sharing on strict networks |
| `MAX_UPLOAD_GB` | `50` | Largest file the host page accepts |
| `ALLOW_REMOTE_HOST`, `HOST` | off, `127.0.0.1` | For running on a remote server; see Security |

## Security

What protects your theatre:

- **The theatre link is the ticket.** Each link contains a long random code.
  Anyone who has the link can join, so share it only with your guests. Closing
  a theatre on the host page makes its link stop working at once.
- **Host powers work only on your computer.** The host page and everything it
  can do (adding and removing movies, opening and closing theatres, being the
  host) are refused for any request that arrives through the public address,
  even with the correct host key.
- **Movies are reachable only through an open theatre's link,** never directly.
- **No ports are opened on your router.** The public address is an outbound,
  encrypted tunnel that exists only while `npm run online` is running.
- The server limits message rates and sizes, rejects cross-site connections,
  and sends strict browser security headers.

What to be aware of:

- **Guests are not individually authenticated.** There are no accounts. A
  guest could forward the link. Up to 16 people fit in a theatre, and you see
  everyone who is seated.
- **Voice, webcams and screen sharing connect viewers directly to each other,**
  which means people in the same theatre can learn each other's IP addresses,
  as in most video calls. A TURN relay (see Settings) avoids that for the
  people who connect through it.
- **Text chat and playback go through your computer** and, when online,
  through Cloudflare's network, which carries the traffic encrypted to and from
  each viewer.
- The host key is stored in `data/state.json`. Delete that file to make a new
  one; this also closes all theatres.
- Running on a remote server with `ALLOW_REMOTE_HOST=1` makes the host key the
  only protection for the host page. Put it behind https and keep the key
  secret.

Found a security problem? Please report it privately to the maintainer rather
than in a public issue.

## Troubleshooting

- **Someone can't be heard or seen, or sees a black screen share.** Their
  network blocks direct connections. Add a TURN relay in `.env`.
- **The picture keeps catching up or looks soft for one person.** Their
  connection is slow; the player has switched to the light version.
- **"Tap to start the sound" appears.** Browsers require one tap before a page
  may play sound.
- **Microphone, camera and screen sharing are unavailable.** Browsers allow
  them only on `https` addresses and on `localhost`.
- **A brand-new fixed address does not load.** New DNS records can take a
  minute or two.

## How it works

```
server/room.js          one theatre: shared clock, seats, roles, chat, share state
server/index.js         web server, WebSocket endpoint, library, uploads
server/ingest.js        ffmpeg: movie file -> adaptive HLS + WebVTT subtitles
server/tunnel*.js       Cloudflare Tunnel (temporary or fixed address)
public/                 the theatre and host pages (plain HTML, CSS and JS)
test/                   tests for the theatre logic (npm test)
```

The server keeps one clock per theatre: "playing since time T from position P".
Each player measures its offset to the server's clock, works out where the
movie should be right now, and nudges its playback speed by a few percent to
stay there, jumping only when it is more than about a second off. Voice, webcam
and screen sharing use WebRTC between browsers; the server only relays their
handshake messages.

## License

MIT. See [LICENSE](LICENSE).
