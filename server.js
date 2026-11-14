// Serveur multijoueur du jeu de survie: sert le jeu (dossier public/) et relaie les joueurs par WebSocket.
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SAVE_FILE = path.join(DATA_DIR, 'world.json');
const MAX_PLAYERS = 12, MAX_PIECES = 800;
const TYPES = ['bench', 'chest', 'bed', 'wall', 'floor', 'roof', 'fire', 'door', 'window', 'stairs'];
// ---------- Simulation partagée: animaux, loups, collisions des pièces (client solo + serveur) ----------
function pieceCols(type, x, z, rot, open) {
  const a = rot * Math.PI / 2, c = Math.cos(a), s = Math.sin(a);
  const wall = (offs, r) => offs.map(o => ({ x: x + o * c, z: z - o * s, r, tag: 'wall' }));
  if (type === 'bench') return [-0.5, 0.5].map(o => ({ x: x + o * c, z: z - o * s, r: 0.5 }));
  if (type === 'chest' || type === 'fire') return [{ x, z, r: type === 'fire' ? 0.7 : 0.55 }];
  if (type === 'bed') return [-0.6, 0.6].map(o => ({ x: x + o * s, z: z + o * c, r: 0.55 }));
  if (type === 'wall' || type === 'window' || (type === 'door' && !open)) return wall([-1.35, -0.45, 0.45, 1.35], 0.4);
  if (type === 'door') return wall([-1.4, 1.4], 0.4);
  return [];
}
function createSim(env) {
  const rnd = env.rnd || Math.random;
  const KINDS = {
    rabbit: { code: 0, hp: 8, walk: 1.6, run: 6.5, fear: 9, r: 0.3 },
    deer: { code: 1, hp: 40, walk: 1.5, run: 8.5, fear: 15, r: 0.6 },
    wolf: { code: 2, hp: 60, walk: 2.2, run: 5.8, r: 0.5 },
    chicken: { code: 3, hp: 6, walk: 1.2, run: 4.5, fear: 6, r: 0.25 },
    pig: { code: 4, hp: 20, walk: 1.2, run: 5, fear: 6, r: 0.45 },
    zombie: { code: 5, hp: 40, walk: 1.3, run: 3.4, r: 0.4, sight: 32 },
  };
  const HOSTILE = { wolf: 1, zombie: 1 };
  const list = [], timers = [];
  let nextId = 1, wolfT = 2, zombT = 4;
  const pick = a => a[(rnd() * a.length) | 0];
  const dist = (a, b, c, d) => Math.hypot(a - c, b - d);
  function nearest(x, z) {
    let b = null, bd = 1e9;
    for (const p of env.players()) { const d = dist(x, z, p.x, p.z); if (d < bd) { bd = d; b = p; } }
    return b ? { p: b, d: bd } : null;
  }
  function fireD(x, z) { let m = 1e9; for (const f of env.fires()) m = Math.min(m, dist(x, z, f.x, f.z)); return m; }
  const okSpot = (x, z, r) => Math.hypot(x, z) < env.R - 6 && dist(x, z, env.pond.x, env.pond.z) > env.pond.r + 2.5 && !env.blocked(x, z, r + 0.3);
  function spawn(kind, x, z) {
    const c = { id: nextId++, kind, x, z, h: rnd() * 6.28, hp: KINDS[kind].hp, t: 0, st: 'idle', panic: 0, by: 0, cd: 0, life: 0, leave: false };
    list.push(c); return c;
  }
  function spawnRandom(kind, near) {
    for (let i = 0; i < 30; i++) {
      let x, z;
      if (near) { const a = rnd() * 6.28, d = 36 + rnd() * 16; x = near.x + Math.sin(a) * d; z = near.z + Math.cos(a) * d; }
      else { const a = rnd() * 6.28, d = 12 + rnd() * (env.R - 24); x = Math.sin(a) * d; z = Math.cos(a) * d; }
      if (!okSpot(x, z, KINDS[kind].r)) continue;
      if (!near) { const n = nearest(x, z); if (n && n.d < 20) continue; }
      return spawn(kind, x, z);
    }
    return null;
  }
  function init() { for (let i = 0; i < 8; i++) spawnRandom('rabbit'); for (let i = 0; i < 5; i++) spawnRandom('deer'); for (let i = 0; i < 6; i++) spawnRandom('chicken'); for (let i = 0; i < 4; i++) spawnRandom('pig'); }
  function stepMove(c, sp, dt) {
    const k = KINDS[c.kind], dx = Math.sin(c.h) * sp * dt, dz = Math.cos(c.h) * sp * dt;
    const tryMove = (nx, nz) => {
      if (Math.hypot(nx, nz) > env.R - 3) return false;
      if (dist(nx, nz, env.pond.x, env.pond.z) < env.pond.r + 1) return false;
      if (env.blocked(nx, nz, k.r)) return false;
      if (HOSTILE[c.kind]) { const fn = fireD(nx, nz); if (fn < 7.5 && fn < fireD(c.x, c.z)) return false; }
      c.x = nx; c.z = nz; return true;
    };
    return tryMove(c.x + dx, c.z + dz) || tryMove(c.x + dx, c.z) || tryMove(c.x, c.z + dz);
  }
  function step(dt) {
    const pl = env.players();
    for (let i = timers.length - 1; i >= 0; i--) { timers[i].t -= dt; if (timers[i].t <= 0) { spawnRandom(timers[i].kind); timers.splice(i, 1); } }
    wolfT -= dt;
    if (wolfT <= 0) {
      wolfT = 3;
      const wolves = list.filter(c => c.kind === 'wolf' && !c.leave).length;
      if (env.night() && pl.length && wolves < Math.min(2 + pl.length * 2, 7)) {
        const c = spawnRandom('wolf', pick(pl)); if (c) { c.st = 'hunt'; if (env.onSpawn) env.onSpawn(c); }
      }
    }
    zombT -= dt;
    if (zombT <= 0) {
      zombT = 4;
      const zs = list.filter(c => c.kind === 'zombie' && !c.leave).length;
      if (env.night() && pl.length && zs < Math.min(2 + pl.length * 2, 6)) { const c = spawnRandom('zombie', pick(pl)); if (c) c.st = 'hunt'; }
    }
    for (let i = list.length - 1; i >= 0; i--) {
      const c = list[i], k = KINDS[c.kind];
      c.life += dt; c.t -= dt; c.cd -= dt; if (c.panic > 0) c.panic -= dt;
      const n = nearest(c.x, c.z);
      if (HOSTILE[c.kind]) {
        if (!c.leave && !env.night()) c.leave = true;
        if (c.leave) {
          if (n) c.h = Math.atan2(c.x - n.p.x, c.z - n.p.z);
          stepMove(c, k.run, dt);
          if (!n || n.d > 75 || c.life > 900 || (c.kind === 'zombie' && (c.burn = (c.burn || 0) + dt) > 6)) list.splice(i, 1);
          continue;
        }
        if (n && n.d < (k.sight || 45)) {
          c.h = Math.atan2(n.p.x - c.x, n.p.z - c.z); c.st = 'hunt';
          if (n.d > 1.2) { if (!stepMove(c, k.run, dt)) c.h += (Math.floor(c.life) % 2 ? 1.1 : -1.1); }
          else if (c.cd <= 0) { c.cd = 1.2; env.onBite(n.p.id, c.kind === 'zombie' ? 7 : 9, c.kind); }
        } else {
          c.st = 'idle'; if (c.t <= 0) { c.t = 2 + rnd() * 3; c.h = rnd() * 6.28; }
          stepMove(c, k.walk, dt);
        }
        continue;
      }
      if (c.panic > 0 || (n && n.d < k.fear)) {
        const ax = n ? c.x - n.p.x : rnd() - 0.5, az = n ? c.z - n.p.z : rnd() - 0.5;
        c.h = Math.atan2(ax, az) + Math.sin(c.life * 3) * 0.4;
        if (!stepMove(c, k.run, dt)) c.h += 1.5;
        c.st = 'flee'; c.t = 0.5;
      } else if (c.t <= 0) {
        if (rnd() < 0.5) { c.st = 'idle'; c.t = 2 + rnd() * 4; } else { c.st = 'walk'; c.t = 2 + rnd() * 3; c.h = rnd() * 6.28; }
      } else if (c.st === 'walk') { if (!stepMove(c, k.walk, dt)) c.t = 0; }
    }
  }
  function hit(id, dmg, by) {
    const c = list.find(o => o.id === id); if (!c) return null;
    c.hp -= dmg; c.panic = 4; c.by = by;
    if (c.hp <= 0) { list.splice(list.indexOf(c), 1); if (!HOSTILE[c.kind]) timers.push({ t: 60 + rnd() * 30, kind: c.kind }); env.onDie(c, by); }
    return c;
  }
  const snapshot = () => list.map(c => [c.id, KINDS[c.kind].code, +c.x.toFixed(1), +c.z.toFixed(1), +c.h.toFixed(2), Math.max(0, c.hp) | 0]);
  return { list, init, step, hit, snapshot, spawn, KINDS };
}


// ----- État du monde -----
const world = { seed: (Math.random() * 2 ** 31) | 0, time: 0.3, day: 1, pieces: new Map(), gone: new Map(), bushes: new Map(), blocks: new Map() };
const BX0 = -104, BZ0 = -104, BNX = 208, BNZ = 208, BY0 = -24, BNY = 48, MAX_BLOCKS = 80000;
const bIdx = (x, y, z) => ((x - BX0) * BNZ + (z - BZ0)) * BNY + (y - BY0);
const bOk = (x, y, z, id) => Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(z) && Number.isInteger(id) && x >= BX0 && x < BX0 + BNX && z >= BZ0 && z < BZ0 + BNZ && y >= BY0 && y < BY0 + BNY && id >= 0 && id <= 19 && id !== 13;
function blocksFlat() { const a = []; for (const [i, id] of world.blocks) { const y = (i % BNY) + BY0, c = (i / BNY) | 0, z = (c % BNZ) + BZ0, x = ((c / BNZ) | 0) + BX0; a.push(x, y, z, id); } return a; }
function loadBlocks(arr) { if (!Array.isArray(arr)) return; for (let i = 0; i + 3 < arr.length && world.blocks.size < MAX_BLOCKS; i += 4) { if (bOk(arr[i], arr[i + 1], arr[i + 2], arr[i + 3])) world.blocks.set(bIdx(arr[i], arr[i + 1], arr[i + 2]), arr[i + 3]); } }
try {
  const d = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
  world.seed = d.seed | 0; world.time = +d.time || 0.3; world.day = d.day | 0 || 1;
  for (const p of d.pieces || []) world.pieces.set(p.key, p);
  loadBlocks(d.blocks);
  world.pieces.forEach((p, k) => { if (!TYPES.includes(p.type)) world.pieces.delete(k); });
  console.log('Monde chargé:', world.pieces.size, 'objets posés,', world.blocks.size, 'cubes modifiés');
} catch (e) { /* nouveau monde */ }
if (process.env.START_TIME) world.time = +process.env.START_TIME;
function cleanPiece(m) {
  if (!m || !TYPES.includes(m.type) || typeof m.key !== 'string' || m.key.length > 80) return null;
  if (!num(m.x) || !num(m.y, 300) || !num(m.z) || !(m.rot >= 0 && m.rot <= 3)) return null;
  const items = {}; let n = 0;
  if (m.items && typeof m.items === 'object') for (const k in m.items) { if (++n > 30) break; const v = m.items[k]; if (k.length <= 20 && typeof v === 'number' && v >= 0 && v <= 9999) items[k] = v | 0; }
  return { type: m.type, x: m.x, y: m.y, z: m.z, rot: m.rot | 0, key: m.key, items, open: !!m.open };
}
let colList = [], fireList = [];
function rebuild() {
  colList = []; fireList = [];
  for (const p of world.pieces.values()) {
    if (p.type === 'fire') fireList.push({ x: p.x, z: p.z });
    for (const c of pieceCols(p.type, p.x, p.z, p.rot, p.open)) colList.push(c);
  }
}
function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SAVE_FILE, JSON.stringify({ seed: world.seed, time: world.time, day: world.day, pieces: [...world.pieces.values()], blocks: blocksFlat() }));
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
const wss = new WebSocketServer({ server, maxPayload: 4 * 1024 * 1024 });
const players = new Map(); // id -> { ws, id, name, x, y, z, yaw }
rebuild();
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
        gone: [...world.gone.keys()], bushes: Object.fromEntries(world.bushes), pieces: [...world.pieces.values()], blocks: blocksFlat(), cr: sim.snapshot(), empty: world.pieces.size === 0 && world.blocks.size === 0,
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
      case 'rtc': { // signalisation du chat vocal (WebRTC): simple relais entre joueurs
        const to = players.get(m.to | 0), str = JSON.stringify(m.d || null);
        if (!to || to === me || str.length > 8000) break;
        if (to.ws.readyState === 1) to.ws.send(JSON.stringify({ t: 'rtc', from: me.id, d: m.d }));
        break;
      }
      case 'blk': {
        const now = Date.now(); me.blkTok = Math.min(40, (me.blkTok === undefined ? 40 : me.blkTok) + (now - (me.blkT || now)) * 0.04); me.blkT = now;
        if (me.blkTok < 1) break; me.blkTok--;
        if (!bOk(m.x, m.y, m.z, m.id) || Math.hypot(m.x + 0.5 - me.x, m.z + 0.5 - me.z) > 20) break;
        const k = bIdx(m.x, m.y, m.z);
        if (!world.blocks.has(k) && world.blocks.size >= MAX_BLOCKS) break;
        world.blocks.set(k, m.id);
        bcast({ t: 'blk', x: m.x, y: m.y, z: m.z, id: m.id }, me);
        break;
      }
      case 'blks': {
        const now = Date.now(); if (me.blksT && now - me.blksT < 80) break; me.blksT = now;
        if (!Array.isArray(m.a) || m.a.length > 8000) break;
        const ok = [];
        for (let i = 0; i + 3 < m.a.length; i += 4) {
          const x = m.a[i], y = m.a[i + 1], z = m.a[i + 2], id = m.a[i + 3];
          if (!bOk(x, y, z, id)) continue;
          const k = bIdx(x, y, z); if (!world.blocks.has(k) && world.blocks.size >= MAX_BLOCKS) continue;
          world.blocks.set(k, id); ok.push(x, y, z, id);
        }
        if (ok.length) bcast({ t: 'blks', a: ok }, me);
        break;
      }
      case 'place': {
        const p = cleanPiece(m);
        if (!p || world.pieces.has(p.key) || world.pieces.size >= MAX_PIECES) break;
        p.items = {}; p.open = false;
        world.pieces.set(p.key, p); rebuild();
        bcast({ t: 'place', ...p }, me);
        break;
      }
      case 'pickp': {
        if (typeof m.key !== 'string' || !world.pieces.has(m.key)) break;
        world.pieces.delete(m.key); rebuild();
        bcast({ t: 'pickp', key: m.key }, me);
        break;
      }
      case 'door': {
        const p = world.pieces.get(m.key);
        if (!p || p.type !== 'door') break;
        p.open = !!m.open; rebuild();
        bcast({ t: 'door', key: m.key, open: p.open }, me);
        break;
      }
      case 'chat': {
        const now = Date.now();
        if (now - (me.lastChat || 0) < 700) break;
        me.lastChat = now;
        const msg = String(m.msg || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 120);
        if (msg) bcast({ t: 'chat', id: me.id, name: me.name, msg });
        break;
      }
      case 'chit': { // coup sur un animal / loup
        const now = Date.now(), dmg = Math.min(50, +m.dmg || 0);
        if (dmg <= 0 || now - (me.lastHit || 0) < 150) break;
        const c = sim.list.find(o => o.id === (m.id | 0));
        if (!c || Math.hypot(c.x - me.x, c.z - me.z) > (m.far && dmg <= 20 ? 70 : 9)) break;
        me.lastHit = now; sim.hit(c.id, dmg, me.id);
        break;
      }
      case 'restore': { // un joueur renvoie le monde sauvegardé chez lui (serveur vide, seul en ligne)
        if (world.pieces.size > 0 || world.blocks.size > 0 || players.size > 1 || !Array.isArray(m.pieces) || m.pieces.length > MAX_PIECES || !num(m.seed, 2 ** 31)) break;
        world.seed = m.seed | 0;
        for (const t of world.gone.values()) clearTimeout(t);
        world.gone.clear(); world.bushes.clear();
        for (const q of m.pieces) { const p = cleanPiece(q); if (p && !world.pieces.has(p.key)) world.pieces.set(p.key, p); }
        loadBlocks(m.blocks);
        rebuild(); save();
        console.log('Monde restauré par', me.name, ':', world.pieces.size, 'objets');
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

// ----- Animaux et loups -----
const sim = createSim({
  R: 95, pond: { x: 18, z: -14, r: 9 },
  players: () => [...players.values()].map(p => ({ id: p.id, x: p.x, z: p.z })),
  night: () => Math.sin((world.time - 0.25) * Math.PI * 2) < 0,
  fires: () => fireList,
  blocked: (x, z, r) => { for (const c of colList) if (Math.hypot(x - c.x, z - c.z) < c.r + r) return true; return false; },
  onBite: (pid, dmg, kind) => { const p = players.get(pid); if (p && p.ws.readyState === 1) p.ws.send(JSON.stringify({ t: 'hurt', dmg, kind })); },
  onDie: (c, by) => { bcast({ t: 'cdie', id: c.id }); const p = players.get(by); if (p && p.ws.readyState === 1) p.ws.send(JSON.stringify({ t: 'loot', kind: c.kind })); },
});
sim.init();
setInterval(() => { if (players.size) sim.step(0.05); }, 50);
setInterval(() => { if (players.size) bcast({ t: 'cr', c: sim.snapshot() }); }, 150);

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
