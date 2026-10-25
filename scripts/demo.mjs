import { mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolveFfmpegPath } from '../dist/impact-frame-video.server.js';
import sharp from 'sharp';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, 'demo-output');
await mkdir(output, { recursive: true });
const palettes = [['#10151f', '#aab9cf'], ['#050505', '#ffffff'], ['#210016', '#ff0088'], ['#220945', '#ffe600'], ['#081400', '#a6ff00'], ['#001340', '#ff7a00'], ['#ffffff', '#e60023']];
for (let index = 0; index < palettes.length; index++) {
  const [background, foreground] = palettes[index];
  const rays = Array.from({ length: 24 }, (_, ray) => `<path d="M320 180 L600 170 L600 190 Z" fill="${foreground}" transform="rotate(${ray * 15} 320 180)"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="${background}"/>${rays}<path d="M260 270 L300 130 L340 130 L390 270 Z" fill="${background}" stroke="${foreground}" stroke-width="10"/><circle cx="320" cy="108" r="27" fill="${background}" stroke="${foreground}" stroke-width="8"/><path d="M280 168 L230 200 M353 165 L422 125" stroke="${foreground}" stroke-width="14"/></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(path.join(output, index ? `impact-${index}.png` : 'reference.png'));
}
execFileSync(resolveFfmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', '-loop', '1', '-i', path.join(output, 'reference.png'),
  '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000', '-t', '3', '-r', '30',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(output, 'source.mp4')], { windowsHide: true, stdio: 'inherit' });
for (const config of ['compose.json', 'image-compose.json']) {
  execFileSync(process.execPath, [path.join(root, 'dist/cli.js'), 'compose', path.join(root, 'examples', config), '--overwrite'], { windowsHide: true, stdio: 'inherit' });
}
console.log(`Local demo written to ${output}. No AI API requests were made.`);
