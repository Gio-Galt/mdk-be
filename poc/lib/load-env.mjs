/**
 * Zero-dependency .env loader for the MDK POC.
 *
 * Reads poc/.env (relative to this file's parent directory) and populates
 * process.env with any key that is NOT already set in the environment.
 * Shell environment variables always take precedence over .env values.
 *
 * Syntax supported:
 *   KEY=value
 *   KEY="value with spaces"
 *   KEY='value with spaces'
 *   KEY=value  # inline comment ignored
 *   # full-line comment — ignored
 *   (blank lines — ignored)
 *
 * Import once, early, as a side-effect module:
 *   import '../lib/load-env.mjs';
 */

import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH  = join(__dirname, '..', '.env');  // poc/.env

if (existsSync(ENV_PATH)) {
  const raw  = readFileSync(ENV_PATH, 'utf8');
  let loaded = 0;

  for (const raw_line of raw.split('\n')) {
    const line = raw_line.trim();

    // Skip blanks and full-line comments
    if (!line || line.startsWith('#')) continue;

    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;

    const key = line.slice(0, eqIdx).trim();
    if (!key) continue;

    let val = line.slice(eqIdx + 1);

    // Strip inline comment (anything after unquoted ' #' or ' #')
    // Only strip if the value is not quoted
    const firstChar = val.trimStart()[0];
    if (firstChar !== '"' && firstChar !== "'") {
      const commentIdx = val.indexOf(' #');
      if (commentIdx !== -1) val = val.slice(0, commentIdx);
    }

    val = val.trim();

    // Strip matching outer quotes
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }

    // Shell env takes precedence — never overwrite already-set vars
    if (process.env[key] === undefined) {
      process.env[key] = val;
      loaded++;
    }
  }

  if (loaded > 0) {
    console.log(`[env] Loaded ${loaded} variable(s) from ${ENV_PATH}`);
  }
}
