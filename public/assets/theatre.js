// Theatre client: synced playback, seats, chat, reactions, voice + webcam.
const $ = (s) => document.querySelector(s);
const roomId = location.pathname.split('/')[2];

// ---------- language (English / Spanish, picked from the device) ----------
const T = {
  en: {
    chat: 'Chat', send: 'Send', say: 'Say something…', name: 'Your name', sit: 'Take your seat',
    headphones: 'Tip: wear headphones if you turn your microphone on, so the movie doesn’t echo.',
    welcome: 'Welcome to', nowShowing: 'Now showing: {movie}', screenOnly: 'Screen sharing theatre', waiting: 'Nothing on the screen yet.', waitingHost: 'Nothing on the screen yet. Press 🖥️ to share your screen.', notFound: 'This theatre link is not valid. Ask your host for a new one.',
    joined: '{name} took a seat', left: '{name} left', played: '{name} pressed play', paused: '{name} paused', seeked: '{name} jumped to {time}',
    reconnecting: 'Reconnecting…', resume: '▶ Tap to start the sound', full: 'The theatre is full.', replaced: 'You opened this theatre in another tab.',
    giveRemote: '🎮 Give the remote', takeRemote: 'Take the remote back', theirVolume: 'Their voice volume',
    gotRemote: 'You have the remote: you can play, pause and skip.', lostRemote: 'The host took the remote back.',
    micDenied: 'Microphone or camera was blocked. Allow it in your browser to use this.', needHttps: 'Voice and camera need a secure (https) link.',
    invite: 'Invite link', show: 'Show', hide: 'Hide', copy: 'Copy', copied: 'Copied ✓', inviteLocal: 'This theatre is not online yet, so this link only works on this computer.',
    subsOff: 'Subtitles off', subsOn: 'Subtitles: {label}',
    live: '● LIVE · {name} is sharing their screen', shareBusy: 'Someone else is already sharing.', shareUnsupported: 'This browser can’t share a screen. Use Chrome, Edge or Firefox on a computer.',
    castTitle: 'Share this computer’s screen', castScreen: 'Screen', castSound: 'Sound', castNoSound: 'No sound', castStart: 'Start broadcast', castStarting: 'Starting…', castBrowser: 'Use the browser’s sharing instead',
    castDelay: 'Captured by Villavisión on this computer. Everyone sees it a few seconds behind, in sync.', castFailed: 'Could not capture the screen ({reason}).',
    castPermission: 'The system blocked the capture. On a Mac, allow Screen Recording for the app that runs Villavisión in System Settings → Privacy & Security, then try again.',
    shareNoAudio: 'Sharing without sound. To include sound, share a browser tab and tick “Also share tab audio”.',
  },
  es: {
    chat: 'Chat', send: 'Enviar', say: 'Escribe algo…', name: 'Tu nombre', sit: 'Tomar asiento',
    headphones: 'Consejo: usa audífonos si enciendes el micrófono, para que la película no haga eco.',
    welcome: 'Bienvenidos a', nowShowing: 'En cartelera: {movie}', screenOnly: 'Sala para compartir pantalla', waiting: 'Todavía no hay nada en la pantalla.', waitingHost: 'Todavía no hay nada en la pantalla. Pulsa 🖥️ para compartir la tuya.', notFound: 'Este enlace no es válido. Pídele uno nuevo al anfitrión.',
    joined: '{name} tomó asiento', left: '{name} salió', played: '{name} puso play', paused: '{name} pausó', seeked: '{name} saltó a {time}',
    reconnecting: 'Reconectando…', resume: '▶ Toca para activar el sonido', full: 'La sala está llena.', replaced: 'Abriste esta sala en otra pestaña.',
    giveRemote: '🎮 Dar el control', takeRemote: 'Quitar el control', theirVolume: 'Volumen de su voz',
    gotRemote: 'Tienes el control: puedes reproducir, pausar y saltar.', lostRemote: 'El anfitrión retomó el control.',
    micDenied: 'El micrófono o la cámara están bloqueados. Permítelos en tu navegador.', needHttps: 'La voz y la cámara necesitan un enlace seguro (https).',
    invite: 'Enlace de invitación', show: 'Mostrar', hide: 'Ocultar', copy: 'Copiar', copied: 'Copiado ✓', inviteLocal: 'Esta sala aún no está en línea; este enlace solo funciona en esta computadora.',
    subsOff: 'Subtítulos apagados', subsOn: 'Subtítulos: {label}',
    live: '● EN VIVO · {name} comparte su pantalla', shareBusy: 'Otra persona ya está compartiendo.', shareUnsupported: 'Este navegador no puede compartir pantalla. Usa Chrome, Edge o Firefox en una computadora.',
    castTitle: 'Compartir la pantalla de esta computadora', castScreen: 'Pantalla', castSound: 'Sonido', castNoSound: 'Sin sonido', castStart: 'Empezar a transmitir', castStarting: 'Empezando…', castBrowser: 'Usar el compartir del navegador',
    castDelay: 'Capturada por Villavisión en esta computadora. Todos la ven con unos segundos de retraso, sincronizados.', castFailed: 'No se pudo capturar la pantalla ({reason}).',
    castPermission: 'El sistema bloqueó la captura. En Mac, permite Grabación de pantalla para la app que ejecuta Villavisión en Ajustes del Sistema → Privacidad y seguridad, y vuelve a intentarlo.',
    shareNoAudio: 'Compartiendo sin sonido. Para incluir sonido, comparte una pestaña del navegador y marca “Compartir audio de la pestaña”.',
  },
};
const lang = (navigator.language || 'en').toLowerCase().startsWith('es') ? 'es' : 'en';
const t = (k, v = {}) => (T[lang][k] || T.en[k] || k).replace(/\{(\w+)\}/g, (_, n) => v[n] ?? '');
document.documentElement.lang = lang;
document.querySelectorAll('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n)));
$('#chatInput').placeholder = t('say');
$('#nameInput').placeholder = t('name');
$('#joinBtn').textContent = t('sit');
$('#resume').textContent = t('resume');

// ---------- helpers ----------
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
const randomId = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
const clientId = store.get('vv.clientId') || (store.set('vv.clientId', randomId()), store.get('vv.clientId')) || randomId();
const fmt = (s) => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const colorFor = (id) => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 55% 42%)`; };

const video = $('#movie');
let ws, me = null, movie = null, state = null, share = null, people = [], joined = false, myName = '';
let clockOffset = 0, bestRtt = Infinity, lastHardSeek = 0, dragging = false, backoff = 500, dead = false, correcting = false;
const serverNow = () => Date.now() + clockOffset;
const canControl = () => me && (me.role === 'host' || me.role === 'cohost');

// ---------- invite link ----------
// Shown masked in the header, like a party-game room code: reveal it when you
// want to read it out, copy it without ever putting it on screen.
const localPage = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
let inviteUrl = location.origin + location.pathname, inviteShown = false;
function renderInvite() {
  $('#inviteLabel').textContent = t('invite');
  $('#inviteLink').textContent = inviteShown ? inviteUrl : '••••••••';
  $('#inviteLink').classList.toggle('masked', !inviteShown);
  $('#inviteShow').textContent = t(inviteShown ? 'hide' : 'show');
  if (!$('#inviteCopy').dataset.busy) $('#inviteCopy').textContent = t('copy');
}
// The host watches on localhost; the link for everyone else is the public one.
const refreshInvite = () => fetch(`/api/room/${roomId}`).then((r) => r.json()).then((info) => {
  inviteUrl = info.invite || location.origin + location.pathname;
  renderInvite();
  return !!info.invite;
}).catch(() => false);
$('#inviteShow').onclick = async () => { inviteShown = !inviteShown; if (inviteShown) await refreshInvite(); renderInvite(); };
$('#inviteCopy').onclick = async () => {
  const online = await refreshInvite();
  try { await navigator.clipboard.writeText(inviteUrl); } catch { inviteShown = true; renderInvite(); return; } // show it so it can be copied by hand
  const b = $('#inviteCopy');
  b.dataset.busy = '1'; b.textContent = t('copied');
  setTimeout(() => { delete b.dataset.busy; renderInvite(); }, 1500);
  if (!online && localPage) notice(t('inviteLocal'), 6000);
};

// ---------- join screen ----------
fetch(`/api/room/${roomId}`).then((r) => (r.ok ? r.json() : Promise.reject())).then((info) => {
  $('#joinTitle').textContent = `${t('welcome')} ${info.name}`;
  $('#joinMovie').textContent = info.movie ? t('nowShowing', { movie: info.movie }) : t('screenOnly');
  $('#roomName').textContent = info.name;
  document.title = info.name;
}).catch(() => {
  $('#joinTitle').textContent = t('notFound');
  $('#nameInput').hidden = $('#joinBtn').hidden = true;
});
$('#nameInput').value = store.get('vv.name') || '';
$('#joinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  myName = $('#nameInput').value.trim();
  if (!myName) return;
  store.set('vv.name', myName);
  // This click is the "user gesture" browsers require before playing sound.
  video.play().then(() => { if (!state?.playing) video.pause(); }).catch(() => {});
  joined = true;
  $('#join').hidden = true;
  connect();
});

// ---------- connection ----------
function send(o) { if (ws?.readyState === 1) ws.send(JSON.stringify(o)); }
function connect() {
  if (dead) return;
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?room=${encodeURIComponent(roomId)}`);
  ws.onopen = () => {
    backoff = 500; bestRtt = Infinity;
    $('#conn').hidden = true;
    send({ type: 'hello', clientId, name: myName, hostKey: store.get('vv.hostKey') || undefined });
    ping();
  };
  ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch (err) { console.error(err); } };
  ws.onclose = () => {
    if (dead) return;
    $('#conn').textContent = t('reconnecting'); $('#conn').hidden = false;
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 8000);
  };
}
function ping() { send({ type: 'ping', t0: Date.now() }); }
setInterval(ping, 5000);

function onMessage(m) {
  switch (m.type) {
    case 'welcome':
      me = m.you; movie = m.movie; state = m.state; share = m.share; people = m.people;
      if (Array.isArray(m.ice) && m.ice.length) ICE = m.ice;
      if (bestRtt === Infinity) clockOffset = m.now - Date.now();
      $('#roomName').textContent = m.room.name;
      $('#invite').hidden = false; renderInvite();
      setupMovie();
      buildSeats(m.room.seats);
      $('#log').textContent = '';
      m.chat.forEach(addChat);
      renderPeople(); syncPeers(); renderShare(); sendMedia(); sync();
      if (screen) send({ type: 'share', on: true, streamId: screen.id }); // reconnected while sharing
      break;
    case 'pong': {
      const now = Date.now(), rtt = now - m.t0;
      if (rtt <= bestRtt + 30) { bestRtt = Math.min(bestRtt, rtt); clockOffset = m.t1 - (m.t0 + rtt / 2); }
      break;
    }
    case 'state': {
      const prev = state; state = m.state;
      if (state.by && prev) {
        if (prev.playing !== state.playing) notice(t(state.playing ? 'played' : 'paused', { name: state.by }));
        else notice(t('seeked', { name: state.by, time: fmt(state.position) }));
      }
      lastHardSeek = 0;
      sync(); renderControls();
      break;
    }
    case 'people': people = m.people; renderPeople(); syncPeers(); renderShare(); break;
    case 'share':
      share = m.share;
      // The host stopped my share, or took the remote back: stop capturing.
      if (screen && (share?.pid !== me.pid || share.kind === 'live')) { for (const track of screen.getTracks()) removeOutgoing(track); screen = null; renderMediaButtons(); }
      renderShare(); sync();
      break;
    case 'role': me.role = m.role; notice(t(m.role === 'cohost' ? 'gotRemote' : 'lostRemote'), 4000); renderShare(); break;
    case 'chat': addChat(m.message); break;
    case 'react': floatEmoji(m.emoji, people.find((p) => p.pid === m.pid)?.name); break;
    case 'signal': onSignal(m).catch((e) => console.warn('signal', e)); break;
    case 'full': case 'replaced': dead = true; notice(t(m.type), 600000); video.pause(); break;
  }
}

// ---------- movie + sync ----------
let movieReady = false;
function setupMovie() {
  if (movieReady) return;
  movieReady = true;
  if (!movie.duration) { document.body.classList.add('nomovie'); return; } // screen sharing only
  const src = `/m/${roomId}/master.m3u8`;
  if (window.Hls?.isSupported()) {
    const hls = new Hls({ maxBufferLength: 30, capLevelToPlayerSize: true });
    hls.on(Hls.Events.ERROR, (_, d) => {
      if (!d.fatal) return;
      if (d.type === Hls.ErrorTypes.NETWORK_ERROR) setTimeout(() => hls.startLoad(), 1500);
      else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
    });
    hls.loadSource(src);
    hls.attachMedia(video);
  } else {
    video.src = src; // Safari / iPhone play HLS natively
  }
  movie.subs.forEach((s) => {
    const tr = document.createElement('track');
    tr.kind = 'subtitles'; tr.label = s.label; tr.srclang = s.lang === 'und' ? '' : s.lang; tr.src = `/m/${roomId}/${s.file}`;
    video.appendChild(tr);
  });
  $('#ccBtn').hidden = movie.subs.length === 0;
  $('#dur').textContent = fmt(movie.duration);
  const want = Number(store.get('vv.sub') ?? -1);
  setTimeout(() => setSub(want < movie.subs.length ? want : -1, true), 0);
}

function targetPos() {
  if (!state) return 0;
  return state.playing ? Math.min(state.position + (serverNow() - state.at) / 1000, movie.duration) : state.position;
}

function tryPlay() {
  const p = video.play();
  if (p) p.then(() => ($('#resume').hidden = true)).catch((e) => { if (e.name === 'NotAllowedError') $('#resume').hidden = false; });
}
$('#resume').onclick = () => { $('#resume').hidden = true; if (state?.playing && !share) tryPlay(); document.querySelectorAll('.avatar video, #shareView').forEach((v) => (v.srcObject || (v.id === 'shareView' && share)) && v.play().catch(() => {})); };

// The heart of it: keep this device's video glued to the shared clock.
function sync() {
  if (!joined || !state || !movie || dead) return;
  const target = targetPos();
  document.body.classList.toggle('playing', state.playing || !!share);
  if (share || !movie.duration) { if (!video.paused) video.pause(); return; } // someone's screen is on the big screen
  if (video.seeking || video.readyState === 0) return;
  const diff = video.currentTime - target;
  if (state.playing) {
    if (video.paused && target < movie.duration - 0.3) tryPlay();
    if (Math.abs(diff) > 1.2) {
      if (Date.now() - lastHardSeek > 4000) { lastHardSeek = Date.now(); video.currentTime = Math.min(target + 0.25, movie.duration); }
      video.playbackRate = 1;
    } else if (video.readyState >= 3 && (Math.abs(diff) > 0.04 || (correcting && Math.abs(diff) > 0.01))) {
      // Nudge gently instead of jumping, and keep nudging until nearly exact,
      // so two viewers end up within a few hundredths of a second of each other.
      correcting = true;
      video.playbackRate = clamp(1 - diff * 0.5, 0.92, 1.08);
    } else { correcting = false; video.playbackRate = 1; }
  } else {
    if (!video.paused) video.pause();
    video.playbackRate = 1;
    if (Math.abs(diff) > 0.05) video.currentTime = target;
  }
}
setInterval(sync, 400);
video.addEventListener('loadedmetadata', sync);
video.addEventListener('canplay', sync);

// ---------- controls ----------
function renderControls() {
  const ctl = canControl();
  $('#playBtn').hidden = !ctl || !!share || !movie?.duration;
  $('#waiting').hidden = !!share || !movie || !!movie.duration;
  $('#waiting').textContent = t(ctl ? 'waitingHost' : 'waiting');
  $('#seek').disabled = !ctl || !!share;
  $('#shareBtn').hidden = !ctl || (!navigator.mediaDevices?.getDisplayMedia && me?.role !== 'host');
  $('#playBtn').textContent = state?.playing ? '⏸' : '▶';
}
setInterval(() => {
  if (!state || !movie?.duration || dragging) return;
  const p = targetPos();
  $('#cur').textContent = fmt(p);
  $('#seek').value = Math.round((p / movie.duration) * 1000);
}, 250);
$('#playBtn').onclick = () => send({ type: 'control', action: state?.playing ? 'pause' : 'play' });
$('#seek').addEventListener('input', () => { dragging = true; $('#cur').textContent = fmt(($('#seek').value / 1000) * movie.duration); });
$('#seek').addEventListener('change', () => { dragging = false; send({ type: 'control', action: 'seek', position: ($('#seek').value / 1000) * movie.duration }); });
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input') || !joined || !canControl() || share || !movie?.duration) return;
  if (e.code === 'Space') { e.preventDefault(); $('#playBtn').click(); }
  if (e.code === 'ArrowLeft') send({ type: 'control', action: 'seek', position: targetPos() - 10 });
  if (e.code === 'ArrowRight') send({ type: 'control', action: 'seek', position: targetPos() + 10 });
});

// Personal settings: these only affect your own device.
video.volume = clamp(Number(store.get('vv.vol') ?? 1), 0, 1);
$('#vol').value = video.volume * 100;
$('#vol').oninput = () => { video.volume = $('#vol').value / 100; video.muted = false; store.set('vv.vol', video.volume); volIcon(); };
$('#muteBtn').onclick = () => { video.muted = !video.muted; volIcon(); };
const volIcon = () => { $('#muteBtn').textContent = video.muted || video.volume === 0 ? '🔇' : '🔊'; if (me) renderShare(); };
volIcon();

let subIdx = -1;
function setSub(i, quiet) {
  subIdx = i;
  [...video.textTracks].forEach((tt, n) => (tt.mode = n === i ? 'showing' : 'disabled'));
  $('#ccBtn').classList.toggle('on', i >= 0);
  store.set('vv.sub', i);
  if (!quiet) notice(i < 0 ? t('subsOff') : t('subsOn', { label: movie.subs[i].label }));
}
$('#ccBtn').onclick = () => setSub(subIdx + 1 >= movie.subs.length ? -1 : subIdx + 1);

$('#chatBtn').onclick = () => $('#app').classList.toggle('chat-open');
if (matchMedia('(max-width: 860px)').matches) $('#app').classList.remove('chat-open');
$('#fsBtn').onclick = () => {
  const el = document.documentElement;
  if (document.fullscreenElement) document.exitFullscreen();
  else if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
  else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); // iPhone
};

let noticeTimer;
function notice(text, ms = 2500) {
  const n = $('#notice');
  n.textContent = text; n.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (n.hidden = true), ms);
}

// ---------- chat + reactions ----------
function addChat(m) {
  const log = $('#log'), el = document.createElement('div');
  const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  el.className = 'msg' + (m.system ? ' system' : '');
  if (m.system) el.textContent = t(m.kind, { name: m.text });
  else {
    const b = document.createElement('b');
    b.textContent = m.name; b.style.setProperty('--c', colorFor(m.pid).replace('42%', '70%'));
    el.append(b, document.createTextNode(m.text));
  }
  log.appendChild(el);
  if (stick) log.scrollTop = log.scrollHeight;
}
$('#chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('#chatInput').value.trim();
  if (text) send({ type: 'chat', text });
  $('#chatInput').value = '';
});
for (const emoji of ['😂', '❤️', '😮', '😢', '👏', '🍿']) {
  const b = document.createElement('button');
  b.type = 'button'; b.textContent = emoji;
  b.onclick = () => send({ type: 'react', emoji });
  $('#emojis').appendChild(b);
}
function floatEmoji(emoji, name) {
  const el = document.createElement('div');
  el.className = 'float';
  el.style.left = 8 + Math.random() * 80 + '%';
  el.textContent = emoji;
  if (name) { const s = document.createElement('small'); s.textContent = name; el.appendChild(s); }
  $('#reactions').appendChild(el);
  setTimeout(() => el.remove(), 3300);
}

// ---------- seats ----------
const seatEls = [], personEls = new Map(), volumes = new Map();
function buildSeats(n) {
  if (seatEls.length) return;
  for (let i = 0; i < n; i++) {
    const s = document.createElement('div');
    s.className = 'seat empty';
    s.onclick = () => { if (s.classList.contains('empty')) send({ type: 'seat', seat: i }); };
    $('#seats').appendChild(s); seatEls.push(s);
  }
}
function personEl(p) {
  let el = personEls.get(p.pid);
  if (!el) {
    el = document.createElement('div');
    el.className = 'person';
    el.innerHTML = '<div class="avatar"><span class="initial"></span><video autoplay playsinline></video></div><div class="pname"></div><div class="badges"></div>';
    el.querySelector('.avatar').style.setProperty('--c', colorFor(p.pid));
    el.onclick = (e) => { e.stopPropagation(); openPopover(p.pid, el); };
    personEls.set(p.pid, el);
  }
  return el;
}
function renderPeople() {
  const here = new Set(people.map((p) => p.pid));
  for (const [pid, el] of personEls) if (!here.has(pid)) { el.remove(); personEls.delete(pid); }
  seatEls.forEach((s) => s.classList.add('empty'));
  for (const p of people) {
    const el = personEl(p), seat = seatEls[p.seat], isMe = p.pid === me.pid;
    el.classList.toggle('me', isMe);
    el.classList.toggle('cam', !!p.cam);
    el.querySelector('.initial').textContent = (p.name[0] || '?').toUpperCase();
    el.querySelector('.pname').textContent = p.name;
    el.querySelector('.badges').textContent = (p.role === 'host' ? '👑' : p.role === 'cohost' ? '🎮' : '') + (p.mic ? '🎤' : '');
    if (seat) {
      seat.classList.remove('empty');
      if (el.parentElement !== seat) { seat.appendChild(el); el.querySelector('video').play().catch(() => {}); }
    }
    if (isMe && me.role !== p.role) { me.role = p.role; renderControls(); }
  }
  attachStreams();
}
function attachStreams() {
  for (const p of people) {
    const v = personEls.get(p.pid)?.querySelector('video');
    if (!v) continue;
    const stream = p.pid === me.pid ? local : (p.streamId && peers.get(p.pid)?.streams.get(p.streamId)) || null;
    if (p.pid === me.pid) v.muted = true; else v.volume = volumes.get(p.pid) ?? 1;
    if (v.srcObject !== (stream || null)) { v.srcObject = stream || null; if (stream) v.play().catch(() => ($('#resume').hidden = false)); }
  }
}
function openPopover(pid, anchor) {
  const p = people.find((x) => x.pid === pid), pop = $('#popover');
  if (!p || pid === me.pid) return (pop.hidden = true);
  pop.textContent = '';
  const title = document.createElement('strong'); title.textContent = p.name; pop.appendChild(title);
  const label = document.createElement('label'), range = document.createElement('input');
  label.textContent = t('theirVolume');
  range.type = 'range'; range.min = 0; range.max = 100; range.value = (volumes.get(pid) ?? 1) * 100;
  range.oninput = () => { volumes.set(pid, range.value / 100); attachStreams(); };
  label.appendChild(range); pop.appendChild(label);
  if (me.role === 'host' && p.role !== 'host') {
    const b = document.createElement('button');
    b.textContent = t(p.role === 'cohost' ? 'takeRemote' : 'giveRemote');
    b.onclick = () => { send({ type: 'role', target: pid, cohost: p.role !== 'cohost' }); pop.hidden = true; };
    pop.appendChild(b);
  }
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  pop.style.left = clamp(r.left + r.width / 2 - 105, 8, innerWidth - 218) + 'px';
  pop.style.top = Math.max(8, r.top - pop.offsetHeight - 8) + 'px';
}
document.addEventListener('click', (e) => { if (!e.target.closest('#popover')) $('#popover').hidden = true; });

// ---------- voice, webcam and screen sharing ----------
// All of it travels directly between viewers (WebRTC); the room only passes
// the handshake messages along.
let ICE = [{ urls: ['stun:stun.cloudflare.com:3478'] }];
const local = new MediaStream(); // my microphone + webcam
const outgoing = new Map(); // every track I send -> the stream it belongs to
const peers = new Map(); // pid -> { pc, sid, polite, makingOffer, ignoreOffer, streams, senders }
let micTrack = null, camTrack = null, micOn = false, screen = null;

function sendMedia() { send({ type: 'media', mic: !!micTrack && micOn, cam: !!camTrack, streamId: local.id }); }

function tune(sender, track) {
  if (outgoing.get(track) !== screen || track.kind !== 'video') return;
  const apply = () => {
    try {
      const params = sender.getParameters();
      if (!params.encodings?.length) return;
      params.encodings[0].maxBitrate = 2_500_000;
      params.degradationPreference = 'maintain-framerate';
      sender.setParameters(params).catch(() => {});
    } catch {}
  };
  apply(); setTimeout(apply, 3000);
}

function ensurePeer(pid, sid) {
  let peer = peers.get(pid);
  if (peer && sid && peer.sid !== sid) { peer.pc.close(); peers.delete(pid); peer = null; } // they reloaded
  if (peer) return peer;
  const pc = new RTCPeerConnection({ iceServers: ICE });
  peer = { pc, sid, polite: me.pid < pid, makingOffer: false, ignoreOffer: false, queue: Promise.resolve(), streams: new Map(), senders: new Map() };
  peers.set(pid, peer);
  pc.onicecandidate = (e) => e.candidate && send({ type: 'signal', to: pid, data: { candidate: e.candidate } });
  pc.onnegotiationneeded = async () => {
    try { peer.makingOffer = true; await pc.setLocalDescription(); send({ type: 'signal', to: pid, data: { description: pc.localDescription } }); }
    catch (e) { console.warn(e); } finally { peer.makingOffer = false; }
  };
  pc.ontrack = (e) => {
    for (const s of e.streams) peer.streams.set(s.id, s);
    const refresh = () => { attachStreams(); renderShare(); };
    e.track.addEventListener('unmute', refresh);
    refresh();
  };
  pc.oniceconnectionstatechange = () => { if (pc.iceConnectionState === 'failed') pc.restartIce(); };
  for (const [track, stream] of outgoing) { const sender = pc.addTrack(track, stream); peer.senders.set(track, sender); tune(sender, track); }
  return peer;
}

// Handshake messages for one person are handled strictly one at a time. If a
// reply and a fresh request arrive back to back, handling them in parallel
// makes the request look like a clash and it gets dropped, leaving that
// person's camera, microphone or shared screen never arriving.
function onSignal(m) {
  if (!m.data || !people.some((p) => p.pid === m.from)) return Promise.resolve();
  const peer = ensurePeer(m.from, m.sid);
  peer.queue = peer.queue.then(() => handleSignal(peer, m)).catch((e) => console.warn('signal', e));
  return peer.queue;
}
async function handleSignal(peer, { from, data }) {
  if (peers.get(from) !== peer) return; // they reconnected meanwhile
  const pc = peer.pc;
  if (data.description) {
    const collision = data.description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
    peer.ignoreOffer = !peer.polite && collision;
    if (peer.ignoreOffer) return;
    await pc.setRemoteDescription(data.description);
    if (data.description.type === 'offer') {
      await pc.setLocalDescription();
      send({ type: 'signal', to: from, data: { description: pc.localDescription } });
    }
  } else if (data.candidate) {
    try { await pc.addIceCandidate(data.candidate); } catch (e) { if (!peer.ignoreOffer) throw e; }
  }
}

function syncPeers() {
  if (!me) return;
  const here = new Map(people.map((p) => [p.pid, p]));
  for (const [pid, peer] of peers) {
    const p = here.get(pid);
    if (!p || p.sid !== peer.sid) { peer.pc.close(); peers.delete(pid); }
  }
  if (outgoing.size) for (const p of people) if (p.pid !== me.pid) ensurePeer(p.pid, p.sid);
  attachStreams();
}

function addOutgoing(track, stream) {
  outgoing.set(track, stream);
  for (const p of people) {
    if (p.pid === me.pid) continue;
    const peer = ensurePeer(p.pid, p.sid);
    if (!peer.senders.has(track)) { const sender = peer.pc.addTrack(track, stream); peer.senders.set(track, sender); tune(sender, track); }
  }
}
function removeOutgoing(track) {
  outgoing.delete(track); track.stop();
  for (const peer of peers.values()) { const s = peer.senders.get(track); if (s) { try { peer.pc.removeTrack(s); } catch {} peer.senders.delete(track); } }
}
async function capture(constraints) {
  if (!navigator.mediaDevices?.getUserMedia) { notice(t('needHttps'), 5000); return null; }
  try { return (await navigator.mediaDevices.getUserMedia(constraints)).getTracks()[0]; }
  catch { notice(t('micDenied'), 5000); return null; }
}
function renderMediaButtons() {
  $('#micBtn').className = 'icon ' + (micTrack && micOn ? 'on' : 'off');
  $('#camBtn').className = 'icon ' + (camTrack ? 'on' : 'off');
  $('#shareBtn').className = 'icon ' + (screen || (share?.kind === 'live' && share.pid === me?.pid) ? 'on' : 'off');
}
$('#micBtn').onclick = async () => {
  if (!micTrack) {
    micTrack = await capture({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (!micTrack) return;
    micOn = true; local.addTrack(micTrack); addOutgoing(micTrack, local);
  } else { micOn = !micOn; micTrack.enabled = micOn; }
  renderMediaButtons(); sendMedia();
};
$('#camBtn').onclick = async () => {
  if (!camTrack) {
    camTrack = await capture({ video: { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15 }, facingMode: 'user' } });
    if (!camTrack) return;
    local.addTrack(camTrack); addOutgoing(camTrack, local);
  } else { local.removeTrack(camTrack); removeOutgoing(camTrack); camTrack = null; }
  renderMediaButtons(); sendMedia(); attachStreams();
};

// Screen sharing: put a window, a browser tab or the whole screen on the big
// screen for everyone, live. Only the host and people holding the remote can.
$('#shareBtn').onclick = async () => {
  if (!$('#cast').hidden) return closeCast();
  if (screen) return stopShare();
  if (share?.kind === 'live' && me.role === 'host') return send({ type: 'share', on: false });
  if (share && share.pid !== me.pid) return notice(t('shareBusy'), 4000);
  // On the host computer Villavisión captures the screen itself.
  if (me.role === 'host') {
    const sources = await api('/api/capture').then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (sources?.supported) return openCast(sources);
  }
  browserShare();
};
async function browserShare() {
  if (!navigator.mediaDevices?.getDisplayMedia) return notice(t('shareUnsupported'), 5000);
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 30 }, width: { max: 1920 }, height: { max: 1080 } },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      systemAudio: 'include',
    });
  } catch { return; } // they cancelled the picker
  if (!canControl() || (share && share.pid !== me.pid)) { stream.getTracks().forEach((tr) => tr.stop()); return; }
  screen = stream;
  for (const track of stream.getTracks()) {
    if (track.kind === 'video') { track.contentHint = 'motion'; track.addEventListener('ended', stopShare); }
    addOutgoing(track, stream);
  }
  send({ type: 'share', on: true, streamId: stream.id });
  if (!stream.getAudioTracks().length) notice(t('shareNoAudio'), 7000);
  renderMediaButtons(); renderShare();
}

// Villavisión's own capture: the server on this computer records the screen
// and broadcasts it to the theatre. Only offered to the host, on that computer.
const api = (path, opts = {}) => fetch(path, { ...opts, headers: { 'x-host-key': store.get('vv.hostKey') || '', 'content-type': 'application/json' } });
const closeCast = () => { $('#cast').hidden = true; };
function openCast(sources) {
  const make = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
  const pick = (key, items) => {
    const sel = make('select', {}, ...items.map((i) => make('option', { value: i.id, textContent: i.label })));
    const saved = store.get(key);
    if (saved !== null && items.some((i) => i.id === saved)) sel.value = saved;
    sel.onchange = () => store.set(key, sel.value);
    return sel;
  };
  const screenSel = pick('vv.castScreen', sources.screens);
  const soundSel = pick('vv.castSound', [{ id: '', label: t('castNoSound') }, ...sources.audio]);
  const start = make('button', { className: 'go', textContent: t('castStart') });
  const other = make('button', { textContent: t('castBrowser') });
  other.hidden = !navigator.mediaDevices?.getDisplayMedia;
  other.onclick = () => { closeCast(); browserShare(); };
  start.onclick = async () => {
    start.disabled = true; start.textContent = t('castStarting');
    const r = await api(`/api/rooms/${roomId}/broadcast`, { method: 'POST', body: JSON.stringify({ screen: screenSel.value, audio: soundSel.value === '' ? null : soundSel.value, pid: me.pid }) }).catch(() => null);
    if (r?.ok) return closeCast();
    const reason = (await r?.json().catch(() => null))?.error || 'offline';
    start.disabled = false; start.textContent = t('castStart');
    notice(reason === 'no_permission' ? t('castPermission') : t('castFailed', { reason }), 9000);
  };
  $('#cast').replaceChildren(
    make('strong', { textContent: t('castTitle') }),
    make('label', {}, make('span', { textContent: t('castScreen') }), screenSel),
    make('label', {}, make('span', { textContent: t('castSound') }), soundSel),
    start, other, make('small', { textContent: t('castDelay') }));
  $('#cast').hidden = false;
}

// Playing someone's captured screen. Viewers hold the same few seconds behind
// the host's clock, so everybody sees the same moment together.
const LIVE_DELAY = 6;
let liveHls = null, liveV = null;
function playLive(v) {
  if (liveV === v) return;
  stopLive();
  liveV = v;
  const view = $('#shareView'), src = `/live/${roomId}/live.m3u8?v=${v}`;
  view.srcObject = null;
  if (window.Hls?.isSupported()) {
    liveHls = new Hls({ liveSyncDuration: 4, liveMaxLatencyDuration: 14, maxBufferLength: 10, backBufferLength: 10 });
    const hls = liveHls;
    hls.on(Hls.Events.ERROR, (_, d) => {
      if (!d.fatal || liveHls !== hls) return;
      if (d.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
      else setTimeout(() => { if (liveHls === hls) { hls.loadSource(src); hls.startLoad(); } }, 1500);
    });
    hls.loadSource(src);
    hls.attachMedia(view);
  } else {
    view.src = src; // Safari / iPhone play it natively
  }
  view.play().catch(() => ($('#resume').hidden = false));
}
function stopLive() {
  if (liveV === null) return;
  liveV = null;
  liveHls?.destroy(); liveHls = null;
  const view = $('#shareView');
  view.playbackRate = 1;
  view.removeAttribute('src'); view.load();
}
setInterval(() => {
  const view = $('#shareView'), at = liveHls?.playingDate;
  if (!at || view.paused || view.readyState < 3 || !view.buffered.length) return;
  const late = (serverNow() - at.getTime()) / 1000 - LIVE_DELAY; // > 0: behind where we should be
  const ahead = view.buffered.end(view.buffered.length - 1) - view.currentTime;
  view.dataset.late = late.toFixed(2); // how far off the shared moment, for troubleshooting
  if (late > 8 && liveHls.liveSyncPosition) view.currentTime = liveHls.liveSyncPosition;
  else view.playbackRate = Math.abs(late) < 0.15 ? 1 : clamp(1 + late * 0.2, 0.9, ahead > 1.5 ? 1.1 : 1);
}, 1000);
function stopShare() {
  if (!screen) return;
  for (const track of screen.getTracks()) removeOutgoing(track);
  screen = null;
  send({ type: 'share', on: false });
  renderMediaButtons(); renderShare();
}
function renderShare() {
  const view = $('#shareView');
  const mine = !!share && share.pid === me?.pid;
  const live = share?.kind === 'live';
  const stream = !share || live ? null : mine ? screen : peers.get(share.pid)?.streams.get(share.streamId) || null;
  if (live) playLive(share.v); else stopLive();
  if (share) closeCast();
  renderMediaButtons();
  document.body.classList.toggle('sharing', !!share);
  view.hidden = !share;
  view.muted = mine || video.muted;
  view.volume = video.volume;
  if (!live && view.srcObject !== stream) { view.srcObject = stream; if (stream) view.play().catch(() => ($('#resume').hidden = false)); }
  $('#live').hidden = !share;
  if (share) $('#live').textContent = t('live', { name: people.find((p) => p.pid === share.pid)?.name || '' });
  renderControls();
}
