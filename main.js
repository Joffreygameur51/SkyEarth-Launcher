const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path'), fs = require('fs'), crypto = require('crypto');
const { Auth } = require('msmc');
const { Client } = require('minecraft-launcher-core');
const DiscordRPC = require('discord-rpc');
const { autoUpdater } = require('electron-updater');

let playing = false, win, session = null, rpc = null, rpcReady = false;
const startTs = Date.now();
const data = () => app.getPath('userData');
const cfgFile = () => path.join(data(), 'config.json');
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');

function loadCfg() {
  const defFile = path.join(__dirname, 'config.json');
  if (!fs.existsSync(cfgFile())) fs.copyFileSync(defFile, cfgFile());
  const defaults = JSON.parse(fs.readFileSync(defFile, 'utf8'));
  return { ...defaults, ...JSON.parse(fs.readFileSync(cfgFile(), 'utf8')) };
}

const fill = (t, cfg) => String(t || '').replace(/{player}/g, session ? session.profile.name : '')
  .replace(/{version}/g, cfg.mcVersion).replace(/{name}/g, cfg.name);

let retry = null;
function stopRpc() {
  clearTimeout(retry);
  const c = rpc; rpc = null; rpcReady = false;
  if (c) try { Promise.resolve(c.destroy()).catch(() => {}); } catch {}
}

function setActivity(playing) {
  if (!rpc || !rpcReady) return;
  const cfg = loadCfg(), ok = t => t && t.length >= 2;   // Discord refuse les textes de moins de 2 caractères
  const a = { startTimestamp: startTs, instance: false };
  const d = fill(playing ? (cfg.rpcDetailsPlaying || cfg.rpcDetails) : cfg.rpcDetails, cfg), s = fill(playing ? cfg.rpcStatePlaying : cfg.rpcState, cfg);
  if (ok(d)) a.details = d;
  if (ok(s)) a.state = s;
  if (cfg.rpcLargeImage) {
    a.largeImageKey = cfg.rpcLargeImage;
    const t = fill(cfg.rpcLargeText, cfg); if (ok(t)) a.largeImageText = t;
  }
  const bl = fill(cfg.rpcButtonLabel, cfg);
  if (ok(bl) && /^https?:\/\//.test(cfg.rpcButtonUrl || '')) a.buttons = [{ label: bl, url: cfg.rpcButtonUrl }];
  console.log('[RPC] envoi du statut :', JSON.stringify(a));
  rpc.setActivity(a).then(() => console.log('[RPC] statut accepté par Discord')).catch(e => console.log('[RPC] activité refusée :', e.message));
}

async function startRpc() {
  stopRpc();
  const cfg = loadCfg();
  if (!cfg.rpcClientId) { console.log('[RPC] aucun Application ID : RPC désactivé'); return; }
  console.log('[RPC] connexion à Discord, ID', cfg.rpcClientId);               // RPC actif dès qu'un Application ID est renseigné
  const again = () => { retry = setTimeout(startRpc, 15000); };   // Discord pas encore ouvert : on réessaie
  const client = new DiscordRPC.Client({ transport: 'ipc' });
  rpc = client;
  client.on('ready', () => { console.log('[RPC] connecté à Discord (' + (client.user && client.user.username) + ')'); rpcReady = true; setActivity(!!session && playing); });
  client.on('disconnected', () => { if (rpc === client) { stopRpc(); again(); } });
  try { await client.login({ clientId: cfg.rpcClientId }); }
  catch (e) { console.log('[RPC]', e.message); if (rpc === client) { stopRpc(); again(); } }
}
app.on('before-quit', stopRpc);

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1100, height: 680, resizable: false, frame: false, backgroundColor: '#0B2A4A',
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  });
  win.loadFile('index.html');
  startRpc();
  initUpdater();
});

ipcMain.handle('win', (_, a) => a === 'close' ? app.quit() : win.minimize());

ipcMain.handle('config:get', async () => {
  const cfg = loadCfg();
  if (cfg.remoteUrl) {                       // le panel admin peut être hébergé en ligne
    try {
      const r = await fetch(cfg.remoteUrl);
      const remote = await r.json();
      delete remote.adminHash; delete remote.remoteUrl;
      return { ...cfg, ...remote, adminHash: undefined };
    } catch {}
  }
  return { ...cfg, adminHash: undefined };
});

// Admin = pseudo Minecraft vérifié par la connexion Microsoft, ou mot de passe
const isAdminName = cfg => !!session && (cfg.admins || []).some(a => String(a).toLowerCase() === session.profile.name.toLowerCase());
ipcMain.handle('admin:isAdmin', () => isAdminName(loadCfg()));

// Réglages propres à chaque joueur
const setFile = () => path.join(data(), 'settings.json');
const loadSet = () => { let s = {}; try { s = JSON.parse(fs.readFileSync(setFile(), 'utf8')); } catch {} return { ram: loadCfg().ram, fullscreen: false, minimize: true, ...s }; };
ipcMain.handle('settings:get', () => loadSet());
ipcMain.handle('settings:set', (_, s) => { fs.writeFileSync(setFile(), JSON.stringify({ ...loadSet(), ...s })); });

ipcMain.handle('server:status', async () => {
  try {
    const j = await (await fetch('https://api.mcsrvstat.us/3/' + encodeURIComponent(loadCfg().serverIp))).json();
    return { online: !!j.online, players: j.players || { online: 0, max: 0 } };
  } catch { return { online: false }; }
});
ipcMain.handle('open', (_, u) => { if (u === 'game') { const r = gameRoot(loadCfg()); fs.mkdirSync(r, { recursive: true }); shell.openPath(r); } else if (/^https:\/\//.test(u)) shell.openExternal(u); });

ipcMain.handle('admin:save', (_, { password, config }) => {
  const cfg = loadCfg();
  if (!isAdminName(cfg) && sha(password) !== cfg.adminHash) return { ok: false, error: 'Accès refusé : pseudo non admin ou mot de passe incorrect' };
  const next = { ...cfg, ...config };
  if (config.newPassword) next.adminHash = sha(config.newPassword);
  delete next.newPassword;
  fs.writeFileSync(cfgFile(), JSON.stringify(next, null, 2));
  startRpc();
  return { ok: true };
});

ipcMain.handle('admin:check', (_, pw) => sha(pw) === loadCfg().adminHash);

ipcMain.handle('admin:pickFile', async (_, kind) => {
  const filters = kind === 'bg'
    ? [{ name: 'Image / vidéo', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'webm'] }]
    : [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'webp', 'svg'] }];
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters });
  if (r.canceled) return null;
  const dir = path.join(data(), 'assets'); fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, kind + path.extname(r.filePaths[0]));
  fs.copyFileSync(r.filePaths[0], dest);
  return 'file:///' + dest.replace(/\\/g, '/') + '?t=' + Date.now();
});

ipcMain.handle('login', async () => {
  try {
    const xbox = await new Auth('select_account').launch('electron');
    session = await xbox.getMinecraft();
    setActivity(false);
    return { ok: true, name: session.profile.name, uuid: session.profile.id };
  } catch (e) { return { ok: false, error: 'Connexion annulée ou échouée' }; }
});

const send = (ch, ...a) => { if (win) win.webContents.send(ch, ...a); };
const gameRoot = cfg => path.join(app.getPath('appData'), '.' + cfg.name.toLowerCase());
const sha1 = f => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
const inside = (root, p) => { const r = path.resolve(root, p); return r.startsWith(path.resolve(root) + path.sep) ? r : null; };

// Mise à jour du launcher lui-même (GitHub Releases)
function initUpdater() {
  if (!app.isPackaged) return;
  autoUpdater.on('update-available', () => send('status', 'Mise à jour du launcher…'));
  autoUpdater.on('download-progress', p => send('progress', Math.round(p.percent)));
  autoUpdater.on('update-downloaded', () => { send('status', 'Mise à jour prête, redémarrage…'); setTimeout(() => autoUpdater.quitAndInstall(), 2500); });
  autoUpdater.on('error', e => console.log('[MAJ]', e.message));
  autoUpdater.checkForUpdates().catch(() => {});
}

// Synchronisation des mods / fichiers du jeu depuis modpack.json
async function syncFiles(cfg, root) {
  if (!cfg.manifestUrl) return {};
  send('status', 'Vérification des fichiers…');
  const r = await fetch(cfg.manifestUrl);
  if (!r.ok) throw new Error('Manifest introuvable (' + r.status + ')');
  const man = await r.json(), files = man.files || [], keep = new Set();
  let done = 0;
  for (const f of files) {
    const dest = inside(root, f.path);
    if (!dest || !/^https:\/\//.test(f.url)) continue;
    keep.add(dest);
    if (!fs.existsSync(dest) || sha1(dest) !== f.sha1) {
      send('status', 'Téléchargement : ' + path.basename(dest));
      const d = await fetch(f.url);
      if (!d.ok) throw new Error('Téléchargement impossible : ' + f.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, Buffer.from(await d.arrayBuffer()));
    }
    send('progress', Math.round(++done / files.length * 100));
  }
  for (const dir of man.prune || ['mods']) {          // mod retiré du manifest = supprimé chez les joueurs
    const d = inside(root, dir);
    if (d && fs.existsSync(d)) for (const n of fs.readdirSync(d)) {
      const f = path.join(d, n);
      if (fs.statSync(f).isFile() && !keep.has(f)) fs.unlinkSync(f);
    }
  }
  return man;
}

ipcMain.handle('launch', async () => {
  if (!session) return { ok: false, error: "Connecte-toi d'abord" };
  const cfg = loadCfg(), root = gameRoot(cfg), mc = new Client();
  let man = {};
  try { man = await syncFiles(cfg, root); } catch (e) { return { ok: false, error: e.message }; }
  send('status', 'Lancement de Minecraft…');
  mc.launch({
    authorization: session.mclc(), root,
    forge: man.forge ? path.join(root, man.forge) : undefined,
    version: { number: man.mcVersion || cfg.mcVersion, type: 'release', custom: man.custom },
    memory: { max: loadSet().ram + 'G', min: '1G' },
    window: loadSet().fullscreen ? { fullscreen: true } : undefined
  });
  mc.on('progress', e => send('progress', Math.round(e.task / e.total * 100)));
  mc.on('close', () => { send('closed'); playing = false; setActivity(false); });
  playing = true; setActivity(true);
  if (loadSet().minimize) win.minimize();
  return { ok: true };
});
