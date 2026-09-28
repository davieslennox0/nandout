// Stable pm2 entry for nandout-web. pm2 runs this in cluster mode; `pm2 reload` starts a new worker (which resolves
// /srv/nandout/current at that moment, i.e. the newly activated release), waits for it to listen, then stops the old one.
// No request sees a closed port during a deploy.
const fs = require('fs');
const path = require('path');
const dir = fs.realpathSync(path.join(process.env.NANDOUT_BASE || '/srv/nandout', 'current', 'web'));
process.chdir(dir);
require(path.join(dir, 'server.js'));
