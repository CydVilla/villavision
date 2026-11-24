// Host page: your library, your theatres, and the links to send.
const $ = (s) => document.querySelector(s);
const m = /key=([\w-]+)/.exec(location.hash);
if (m) { localStorage.setItem('vv.hostKey', m[1]); history.replaceState(null, '', location.pathname); }
const key = localStorage.getItem('vv.hostKey') || '';
const api = (path, opts = {}) => fetch(path, { ...opts, headers: { 'x-host-key': key, 'content-type': 'application/json' } });
const fmt = (s) => { s = Math.floor(s); const h = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60); return h ? `${h}h ${mm}m` : `${mm}m`; };
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
let publicUrl = '', upload = null;

async function load() {
  const r = await api('/api/library');
  if (!r.ok) { $('#locked').hidden = false; $('#dash').hidden = true; return; }
  $('#dash').hidden = false;
  const { movies, rooms, jobs, publicUrl: url } = await r.json();
  publicUrl = url;
  const title = Object.fromEntries(movies.map((x) => [x.id, x.title]));

  $('#online').replaceChildren(el('div', { className: 'grow' }, ...(publicUrl
    ? [el('strong', { className: 'ok', textContent: '● Online' }), el('small', { textContent: `Family links start with ${publicUrl}` })]
    : [el('strong', { className: 'warn', textContent: '● This computer only' }), el('small', { textContent: 'People outside can’t join yet. Stop the server and start it with:  npm run online' })])));

  $('#rooms').replaceChildren(...(rooms.length ? rooms.map((room) => {
    const copy = el('button', { textContent: 'Copy family link' });
    copy.onclick = async () => { await navigator.clipboard.writeText((publicUrl || location.origin) + '/r/' + room.id); copy.textContent = 'Copied ✓'; setTimeout(() => (copy.textContent = 'Copy family link'), 1500); };
    const del = el('button', { className: 'danger', textContent: 'Close' });
    del.onclick = async () => { if (confirm(`Close "${room.name}"? Its link will stop working.`)) { await api('/api/rooms/' + room.id, { method: 'DELETE' }); load(); } };
    return el('div', { className: 'row' },
      el('div', { className: 'grow' }, el('strong', { textContent: room.name }), el('small', { textContent: `${title[room.movieId] || 'movie missing'} · ${room.people} watching · at ${fmt(room.position || 0)}` })),
      el('a', { className: 'btn primary', href: '/r/' + room.id, textContent: 'Enter' }), copy, del);
  }) : [el('p', { className: 'dim', textContent: 'No theatres open yet. Open one from a movie below.' })]));

  $('#movies').replaceChildren(...(movies.length ? movies.map((mv) => {
    const open = el('button', { className: 'primary', textContent: 'Open a theatre' });
    open.onclick = async () => {
      const name = prompt('Name for this theatre:', `${mv.title} night`);
      if (name === null) return;
      await api('/api/rooms', { method: 'POST', body: JSON.stringify({ movieId: mv.id, name }) });
      load();
    };
    const del = el('button', { className: 'danger', textContent: 'Remove' });
    del.onclick = async () => { if (confirm(`Remove "${mv.title}" from the library? Theatres showing it will close. Your original file is not touched.`)) { await api('/api/movies/' + mv.id, { method: 'DELETE' }); load(); } };
    return el('div', { className: 'row' }, el('div', { className: 'grow' }, el('strong', { textContent: mv.title }), el('small', { textContent: `${fmt(mv.duration)} · up to ${mv.height}p` })), open, del);
  }) : [el('p', { className: 'dim', textContent: 'Your library is empty.' })]));

  const rows = jobs.map((j) => el('div', { className: 'row' },
    el('div', { className: 'grow' }, el('strong', { textContent: j.title }), el('small', { textContent: j.status === 'error' ? `Failed: ${j.error}` : j.status === 'queued' ? 'Waiting…' : j.status === 'done' ? 'Ready ✓' : 'Preparing for streaming… (keep this computer awake)' })),
    ...(j.status === 'preparing' ? [el('progress', { max: 100, value: j.pct }), el('small', { textContent: `${j.pct}%` })] : [])));
  if (upload) rows.unshift(el('div', { className: 'row' }, el('div', { className: 'grow' }, el('strong', { textContent: upload.name }), el('small', { textContent: 'Copying…' })), el('progress', { max: 100, value: upload.pct })));
  $('#jobs').replaceChildren(...rows);
  clearTimeout(load.timer);
  if (jobs.some((j) => j.status === 'queued' || j.status === 'preparing' || j.status === 'done')) load.timer = setTimeout(load, 1500);
}

$('#addBtn').onclick = () => $('#file').click();
$('#file').onchange = () => {
  const file = $('#file').files[0];
  if (!file) return;
  const title = prompt('Movie title:', file.name.replace(/\.[^.]+$/, '').replace(/[._]+/g, ' '));
  $('#file').value = '';
  if (title === null) return;
  const xhr = new XMLHttpRequest();
  upload = { name: title || file.name, pct: 0 };
  xhr.open('POST', `/api/movies?filename=${encodeURIComponent(file.name)}&title=${encodeURIComponent(title)}`);
  xhr.setRequestHeader('x-host-key', key);
  xhr.upload.onprogress = (e) => { const pct = Math.round((e.loaded / e.total) * 100); if (pct !== upload.pct) { upload.pct = pct; load(); } };
  xhr.onloadend = () => {
    upload = null;
    if (xhr.status !== 200) { let msg = 'The file could not be added.'; try { msg = JSON.parse(xhr.responseText).error || msg; } catch {} alert(msg); }
    load();
  };
  xhr.send(file);
  load();
};
load();
