// Builds the web app (shared by the desktop app and the PWA) and the Electron shell with esbuild.
//
//   node scripts/build.mjs            production build -> dist/
//   node scripts/build.mjs --serve    dev server for the web app on http://localhost:5173
//
import * as esbuild from 'esbuild';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const serve = args.has('--serve');
// Release builds (installer / Store package) must ship every model so the app works offline.
const release = args.has('--release');
const REQUIRED_MODELS = ['face_landmarker.task', 'hand_landmarker.task', 'efficientdet_lite0.tflite'];
const outDir = path.join(root, 'dist');
const webOut = path.join(outDir, 'web');
const electronOut = path.join(outDir, 'electron');

// Test hook: `--mock` swaps MediaPipe for a scripted fake (used by the headless smoke test).
const mockMediapipe =
  process.env.FACE_GUARD_MOCK_MEDIAPIPE ?? (args.has('--mock') ? path.join(root, 'tests/mocks/tasks-vision.ts') : undefined);

const rendererOptions = {
  entryPoints: [path.join(root, 'src/renderer/main.ts')],
  outfile: path.join(webOut, 'app.js'),
  bundle: true,
  format: 'esm',
  target: ['chrome110', 'safari16'],
  sourcemap: true,
  minify: !serve,
  logLevel: 'info',
  alias: mockMediapipe ? { '@mediapipe/tasks-vision': mockMediapipe } : undefined,
};

async function copyStatic() {
  await cp(path.join(root, 'src/renderer/public'), webOut, { recursive: true });

  const wasmSrc = path.join(root, 'node_modules/@mediapipe/tasks-vision/wasm');
  if (existsSync(wasmSrc)) {
    await cp(wasmSrc, path.join(webOut, 'wasm'), { recursive: true });
  } else if (!mockMediapipe) {
    throw new Error('MediaPipe WASM not found. Run `npm install` first.');
  }

  const models = path.join(root, 'models');
  if (release) {
    const missing = REQUIRED_MODELS.filter((m) => !existsSync(path.join(models, m)));
    if (missing.length) {
      throw new Error(`Release build is missing models: ${missing.join(', ')}. Run \`npm run fetch-models\` first.`);
    }
  }
  if (existsSync(models)) {
    await cp(models, path.join(webOut, 'models'), { recursive: true, filter: (f) => !f.endsWith('.part') });
  } else {
    console.warn('! models/ is missing — the app will download models at runtime. Run `npm run fetch-models`.');
  }
}

async function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full, base)));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

/** Service worker that precaches the whole app (models + WASM included) so the PWA works offline. */
async function writeServiceWorker() {
  const files = (await listFiles(webOut)).filter(
    (f) => f !== 'sw.js' && !f.endsWith('.map') && !f.includes('nosimd') && !/^(popup|countdown)\./.test(f),
  );
  const hash = createHash('sha256');
  for (const f of files.sort()) {
    const s = await stat(path.join(webOut, f));
    hash.update(`${f}:${s.size}:${s.mtimeMs}`);
  }
  const version = `face-guard-${hash.digest('hex').slice(0, 12)}`;
  const template = await readFile(path.join(root, 'src/renderer/sw.template.js'), 'utf8');
  const sw = template
    .replace('__VERSION__', version)
    .replace('__ASSETS__', JSON.stringify(['./', ...files.map((f) => `./${f}`)], null, 2));
  await writeFile(path.join(webOut, 'sw.js'), sw);
}

async function buildElectron() {
  await esbuild.build({
    entryPoints: {
      main: path.join(root, 'src/electron/main.ts'),
      preload: path.join(root, 'src/electron/preload.ts'),
    },
    outdir: electronOut,
    outExtension: { '.js': '.cjs' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
    sourcemap: true,
    logLevel: 'info',
  });
  const assets = path.join(electronOut, 'assets');
  await mkdir(assets, { recursive: true });
  for (const f of await readdir(path.join(root, 'build'))) {
    if (f.startsWith('tray-') || f === 'icon.png') await cp(path.join(root, 'build', f), path.join(assets, f));
  }
}

await rm(outDir, { recursive: true, force: true });
await mkdir(webOut, { recursive: true });
await copyStatic();

if (serve) {
  await writeServiceWorker();
  const ctx = await esbuild.context(rendererOptions);
  await ctx.watch();
  const { port } = await ctx.serve({ servedir: webOut, port: 5173 });
  console.log(`\n  Face Guard (web) running at http://localhost:${port}\n`);
} else {
  await esbuild.build(rendererOptions);
  await writeServiceWorker();
  await buildElectron();
  console.log('Build complete -> dist/');
}
