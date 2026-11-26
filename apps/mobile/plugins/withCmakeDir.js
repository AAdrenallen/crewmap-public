// Windows: ninja < 1.12 can't handle paths > 260 chars (New-Architecture codegen objects exceed it). Point every
// native module at a CMake whose ninja supports long paths, via local.properties `cmake.dir`.
const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('expo/config-plugins');

const CMAKE_VERSION = '3.31.6';

module.exports = function withCmakeDir(config) {
  return withDangerousMod(config, [
    'android',
    async (cfg) => {
      const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
      if (!sdk) return cfg;
      const cmake = path.join(sdk, 'cmake', CMAKE_VERSION);
      if (!fs.existsSync(cmake)) return cfg;
      const file = path.join(cfg.modRequest.platformProjectRoot, 'local.properties');
      const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => !/^(cmake\.dir|sdk\.dir)=/.test(l)) : [];
      const fwd = (p) => p.split(path.sep).join('/');
      lines.push(`sdk.dir=${fwd(sdk)}`, `cmake.dir=${fwd(cmake)}`);
      fs.writeFileSync(file, lines.filter(Boolean).join('\n') + '\n');
      return cfg;
    },
  ]);
};
