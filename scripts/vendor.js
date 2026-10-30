// Copies the browser build of chess.js from node_modules into vendor/.
// Run after upgrading chess.js:  npm install chess.js@latest --save-dev && npm run vendor
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const src = 'node_modules/chess.js/dist/esm/chess.js';
const code = readFileSync(src, 'utf8').replace(/^\/\/# sourceMappingURL=.*$/m, '');
writeFileSync('vendor/chess.js', code);
copyFileSync('node_modules/chess.js/LICENSE', 'vendor/chess.js.LICENSE');
const { version } = JSON.parse(readFileSync('node_modules/chess.js/package.json', 'utf8'));
console.log(`vendor/chess.js updated to chess.js ${version}`);
