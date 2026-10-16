// Downloads the MediaPipe models into ./models so the app works fully offline.
// Runs automatically after `npm install`. Safe to re-run; skips files that already exist.
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'models');

const MODELS = {
  'face_landmarker.task':
    'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  'hand_landmarker.task':
    'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  // Recognises cups / bottles so drinking isn't counted as touching your face.
  // Several published variants; the first one that downloads is used.
  'efficientdet_lite0.tflite': [
    'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite',
    'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/1/efficientdet_lite0.tflite',
    'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float32/1/efficientdet_lite0.tflite',
  ],
};

mkdirSync(dir, { recursive: true });
let failed = false;

for (const [name, urls] of Object.entries(MODELS)) {
  const dest = path.join(dir, name);
  if (existsSync(dest) && statSync(dest).size > 0) {
    console.log(`✓ ${name} (already downloaded)`);
    continue;
  }
  const errors = [];
  let done = false;
  for (const url of [urls].flat()) {
    try {
      const res = await fetch(url);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} from ${url}`);
      const tmp = `${dest}.part`;
      await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
      renameSync(tmp, dest);
      console.log(`✓ ${name} (${(statSync(dest).size / 1e6).toFixed(1)} MB)`);
      done = true;
      break;
    } catch (err) {
      errors.push(err.message);
    }
  }
  if (!done) {
    failed = true;
    console.warn(`! Could not download ${name}:\n    ${errors.join('\n    ')}`);
  }
}

if (failed) {
  console.warn('! Some models are missing. The app will try to download them at runtime instead.');
}
