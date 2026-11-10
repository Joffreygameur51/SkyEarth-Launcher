// Génère modpack.json à partir d'un dossier de fichiers (mods, config, forge...).
// Usage : node tools/make-manifest.js <dossier> <https://url-de-base> [versionMinecraft] [chemin/forge-installer.jar]
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const [dir, base, mc, forge] = process.argv.slice(2);
if (!dir || !base) { console.log('Usage : node tools/make-manifest.js <dossier> <https://url-de-base> [versionMinecraft] [forge.jar]'); process.exit(1); }
const files = [];
(function walk(d) {
  for (const n of fs.readdirSync(d)) {
    const p = path.join(d, n);
    if (fs.statSync(p).isDirectory()) { walk(p); continue; }
    const rel = path.relative(dir, p).split(path.sep).join('/');
    if (rel === 'modpack.json') continue;
    files.push({ path: rel, url: base.replace(/\/$/, '') + '/' + rel.split('/').map(encodeURIComponent).join('/'),
      sha1: crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex') });
  }
})(dir);
fs.writeFileSync(path.join(dir, 'modpack.json'), JSON.stringify({ mcVersion: mc || undefined, forge: forge || undefined, prune: ['mods'], files }, null, 2));
console.log(files.length + ' fichiers → ' + path.join(dir, 'modpack.json'));
