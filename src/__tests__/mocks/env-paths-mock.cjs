'use strict';
const path = require('path');
const os = require('os');

/** Minimal stub so Jest (CJS) can load `server.ts` without pulling ESM `env-paths`. */
module.exports = function envPaths(name, opts) {
  const suffix = opts && opts.suffix !== undefined ? opts.suffix : 'nodejs';
  const base = path.join(os.tmpdir(), String(name) + suffix);
  return {
    data: base,
    config: base,
    cache: base,
    log: base,
    temp: os.tmpdir(),
  };
};
