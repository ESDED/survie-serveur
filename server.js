// Serveur multijoueur du jeu de survie: sert le jeu (dossier public/) et relaie les joueurs par WebSocket.
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SAVE_FILE = path.join(DATA_DIR, 'world.json');
const MAX_PLAYERS = 12, MAX_PIECES = 800;
const TYPES = ['bench', 'chest', 'bed', 'wall', 'floor', 'roof', 'fire'];

// ----- État du monde -----
const world = { seed: (Math.random() * 2 ** 31) | 0, time: 0.3, day: 1, pieces: new Map(), gone: new Map(), bushes: new Map() };
try {
  const d = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
  world.seed = d.seed | 0; world.time = +d.time || 0.3; world.day = d.day | 0 || 1;
  for (const p of d.pieces || []) world.pieces.set(p.key, p);
  console.log('Monde chargé:', world.pieces.size, 'objets posés');
} catch (e) { /* nouveau monde */ }
function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SAVE_FILE, JSON.stringify({ seed: world.seed, time: world.time, day: world.day, pieces: [...world.pieces.values()] }));
  } catch (e) { /* disque indisponible: tant pis */ }
}
setInterval(save, 30000);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { save(); process.exit(0); });

// ----- HTTP (fichiers du jeu) -----
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = path.join(__dirname, 'public', path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));
  if (!f.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); res.end(); return; }
  fs.readFile(f, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Introuvable'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
});

// ----- WebSocket -----
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
const players = new Map(); // id -> { ws, id, name, x, y, z, yaw }
let nextId = 1, dirty = false;
const num = (v, lim = 400) => typeof v === 'number' && isFinite(v) && Math.abs(v) <= lim;
const cleanName = n => String(n || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 16) || 'Joueur';
function bcast(o, except) {
  const s = JSON.stringify(o);
  for (const p of players.values()) if (p !== except && p.ws.readyState === 1) p.ws.send(s);
}

wss.on('connection', ws => {
  let me = null, last = 0;
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    if (!me) {
      if (m.t !== 'join') return;
      if (players.size >= MAX_PLAYERS) { ws.close(); return; }
      me = { ws, id: nextId++, name: cleanName(m.name), x: 0, y: 0, z: 6, yaw: 0 };
      ws.send(JSON.stringify({
        t: 'welcome', id: me.id, seed: world.seed, time: world.time, day: world.day,
        gone: [...world.gone.keys()], bushes: Object.fromEntries(world.bushes), pieces: [...world.pieces.values()],
        players: [...players.values()].map(p => ({ id: p.id, name: p.name, x: p.x, y: p.y, z: p.z, yaw: p.yaw })),
      }));
      players.set(me.id, me);
      bcast({ t: 'join', id: me.id, name: me.name, x: me.x, y: me.y, z: me.z, yaw: me.yaw }, me);
      console.log('+', me.name, '(' + players.size + ' en ligne)');
      return;
    }
    switch (m.t) {
      case 'pos':
        if (num(m.x) && num(m.y, 300) && num(m.z) && num(m.yaw, 20)) { me.x = m.x; me.y = m.y; me.z = m.z; me.yaw = m.yaw; dirty = true; }
        break;
      case 'rm': { // arbre / roche détruit
        const id = m.id | 0;
        if (id < 0 || id > 2000 || world.gone.has(id)) break;
        const t = setTimeout(() => { world.gone.delete(id); bcast({ t: 'res', id, on: true }); }, 70000 + Math.random() * 40000);
        world.gone.set(id, t);
        bcast({ t: 'res', id, on: false }, me);
        break;
      }
      case 'bush': {
        const id = m.id | 0, c = m.count | 0;
        if (id < 0 || id > 2000 || c < 0 || c > 6) break;
        world.bushes.set(id, c);
        bcast({ t: 'bush', id, count: c }, me);
        break;
      }
      case 'place': {
        if (!TYPES.includes(m.type) || typeof m.key !== 'string' || m.key.length > 80) break;
        if (!num(m.x) || !num(m.y, 300) || !num(m.z) || !(m.rot >= 0 && m.rot <= 3)) break;
        if (world.pieces.has(m.key) || world.pieces.size >= MAX_PIECES) break;
        const p = { type: m.type, x: m.x, y: m.y, z: m.z, rot: m.rot | 0, key: m.key, items: {} };
        world.pieces.set(p.key, p);
        bcast({ t: 'place', ...p }, me);
        break;
      }
      case 'pickp': {
        if (typeof m.key !== 'string' || !world.pieces.has(m.key)) break;
        world.pieces.delete(m.key);
        bcast({ t: 'pickp', key: m.key }, me);
        break;
      }
      case 'chest': {
        const p = world.pieces.get(m.key);
        if (!p || !m.items || typeof m.items !== 'object') break;
        const items = {}; let n = 0;
        for (const k in m.items) { if (++n > 30) break; const v = m.items[k]; if (k.length <= 20 && typeof v === 'number' && v >= 0 && v <= 9999) items[k] = v | 0; }
        p.items = items;
        bcast({ t: 'chest', key: m.key, items }, me);
        break;
      }
      case 'time': // le sommeil remet le jour pour tout le monde
        if (m.v === 0.27) { world.time = 0.27; if (num(m.day, 100000)) world.day = Math.max(world.day, m.day | 0); bcast({ t: 'time', v: world.time, day: world.day }); }
        break;
    }
  });
  ws.on('close', () => {
    if (!me) return;
    players.delete(me.id);
    bcast({ t: 'leave', id: me.id });
    console.log('-', me.name, '(' + players.size + ' en ligne)');
  });
  ws.on('error', () => {});
});

// positions des joueurs (10/s) et heure (toutes les 3 s)
setInterval(() => {
  if (!dirty) return; dirty = false;
  bcast({ t: 'ps', p: [...players.values()].map(p => ({ id: p.id, x: p.x, y: p.y, z: p.z, yaw: p.yaw })) });
}, 100);
let tick = 0;
setInterval(() => {
  world.time += 1 / 300;
  if (world.time >= 1) { world.time -= 1; world.day++; }
  if (++tick % 3 === 0) bcast({ t: 'time', v: world.time, day: world.day });
}, 1000);

server.listen(PORT, () => console.log('Serveur de survie sur le port ' + PORT));
