# The shared computer (removed, kept here for later)

An experiment that worked and was taken out to keep Villavisión small: a
Linux desktop with a web browser, running in a virtual machine on the host's
Mac and shown on the theatre's big screen. The host and anyone holding the
remote could use its mouse and keyboard; everyone else watched, with sound.
The idea was pairing on code or looking something up together.

## Where the code is

All of it is in git at commit `37d1df6`, switched off behind
`SHARED_COMPUTER=1`. To look at it or bring it back:

```bash
git show 37d1df6 --stat
```

```bash
git checkout 37d1df6 -- server/workspace.js server/rfb.js server/deskaudio.js server/native/vv-vm.swift server/native/vv-vm.entitlements server/vm/user-data test/rfb.test.js test/deskaudio.test.js
```

The second command restores the standalone files. The glue has to be put back
by hand from the same commit (search it for `desk`):

| File | What was there |
|---|---|
| `server/index.js` | `/api/workspace`, `/api/workspace/setup`, `/api/rooms/:id/desk`, `/vendor/novnc/*`, and the WebSocket bridges `/desk`, `/desksound`, `/deskpicture` |
| `server/room.js` | `startDesk`, the `{ kind: 'desk' }` share, a private `ticket` per person, `personByTicket`, `onRole`, `onDeskEnd` |
| `public/assets/theatre.js` | `showDesk` / `hideDesk` / `connectDesk`, the `liveStream` player, the "Start a shared computer" button in the share panel |
| `public/assets/host.js`, `public/host.html` | the "Shared computer" set-up row |
| `public/theatre.html`, `theatre.css` | `#deskView` and `#deskVideo` |
| `package.json` | the `@novnc/novnc` dependency |

## How it worked

- **The machine.** `vv-vm.swift` boots Debian 13 (the official "genericcloud"
  image) with Apple's Virtualization framework: EFI boot, NAT network, serial
  console. The server compiles it with `swiftc` and signs it locally with the
  `com.apple.security.virtualization` entitlement.
- **One-time setup** (`workspace.js`, about 6 minutes, about 700 MB). Download
  the image, check it against Debian's SHA512SUMS, boot it once with a
  cloud-init seed (`vm/user-data`, on an ISO made with `hdiutil makehybrid`,
  label `cidata`) that installs Xfce, Chromium, TigerVNC, PulseAudio and
  ffmpeg, then powers off. A second boot must print `VV-READY` before the
  result is kept as the master disk.
- **Each start** (about 25 seconds) is an APFS clone of the master disk, so it
  is instant to create and erased when shut down. The guest reports
  `VV-READY <ip>` on the serial console once the desktop is up.
- **Inside the machine:** Xvnc on port 5901 at 1600x900, a PulseAudio null
  sink, ffmpeg sending sound alone on 5902 and screen plus sound as H.264/AAC
  fragmented MP4 on 5903.
- **Two ways of seeing it.** People holding the remote got noVNC over a
  WebSocket bridge (instant, for typing) plus the sound stream. Everyone else
  got the video stream through Media Source Extensions: 30 frames a second,
  about 1.5 seconds behind, up to about 4.5 Mbit/s.
- **Who could type** was enforced on the server. `rfb.js` read the VNC protocol
  coming from a watcher's browser and passed on only requests for pictures,
  dropping keys, pointer movement and clipboard text. Each person proved who
  they were with a private ticket sent as the first WebSocket message, never
  in a URL.

## What was measured

- Watcher stream over the public link: 30.1 frames a second, no dropped
  frames, no stalls.
- Host view: about 42 screen updates a second.
- A guest's injected key and pointer messages were dropped; a wrong ticket was
  refused; handing over the remote enabled typing; shutting down erased the
  machine.

## What was never finished or checked

- Sound on the host's own side was confirmed by measurement, not by ear.
- The watcher stream on a slow connection.
- Intel Macs. Windows and Linux hosts were not supported at all.
- The machine can reach the host's home network, like any computer plugged in
  at home. Decide whether to fence that off before bringing it back.
- Chromium plays no DRM video, and it must stay that way.
