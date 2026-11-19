// Icons neu erzeugen: node test/make-icons.mjs (braucht sharp, z. B. npm i --no-save sharp)
// iOS rundet App-Icons selbst ab und füllt Durchsichtiges schwarz: die PNGs sind deshalb volle, eckige Quadrate ohne Transparenz.
import sharp from 'sharp';
import { readFileSync } from 'node:fs';
const svg = readFileSync('public/icon.svg', 'utf8');
const square = Buffer.from(svg.replace('rx="112" ', ''));
const flat = (s) => sharp(s).flatten({ background: '#2E5E3E' });
await flat(square).resize(192, 192).png().toFile('public/icon-192.png');
await flat(square).resize(512, 512).png().toFile('public/icon-512.png');
await flat(square).resize(180, 180).png().toFile('public/apple-touch-icon.png');
// Maskable (Android): Inhalt mit Rand, volle Fläche grün
const inner = await sharp(square).resize(400, 400).png().toBuffer();
await sharp({ create: { width: 512, height: 512, channels: 3, background: '#2E5E3E' } })
  .composite([{ input: inner, left: 56, top: 56 }]).png().toFile('public/icon-maskable-512.png');
console.log('icons ok');
