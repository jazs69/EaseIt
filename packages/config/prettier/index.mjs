// The canonical Prettier configuration is the repository-root `.prettierrc`, so
// editors, the `format` script and this shared export can never drift apart.
// Read as JSON rather than `require()`d: Node has no loader registered for the
// `.prettierrc` extension and would try to parse the file as JavaScript.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const rcPath = fileURLToPath(new URL('../../../.prettierrc', import.meta.url));

/** @type {import('prettier').Config} */
const config = JSON.parse(readFileSync(rcPath, 'utf8'));

export default config;
