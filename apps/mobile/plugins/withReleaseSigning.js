// Release builds are signed with the public React Native debug key (same as Govori; owner decision, docs/RELEASE.md).
// The keystore is pinned in this folder (SHA-256 of the file checked below) and copied into android/app on every
// prebuild, so `expo prebuild --clean` can never yield a different key. Also strips the retired upload-key block.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { withAppBuildGradle, withDangerousMod } = require('expo/config-plugins');

const KEYSTORE = path.join(__dirname, 'debug.keystore');
const KEYSTORE_SHA256 = '221e0a3106aa4c3ccc154e0a418b55020b3f9ea6e84f92e8749cd9e2f39f5e58';
const LEGACY = /\n\/\/ crewmap-release-signing\n[\s\S]*?\n}\n/;

module.exports = function withReleaseSigning(config) {
  config = withDangerousMod(config, [
    'android',
    (cfg) => {
      const data = fs.readFileSync(KEYSTORE);
      const sha = crypto.createHash('sha256').update(data).digest('hex');
      if (sha !== KEYSTORE_SHA256) throw new Error(`plugins/debug.keystore changed (sha256 ${sha})`);
      fs.writeFileSync(path.join(cfg.modRequest.platformProjectRoot, 'app', 'debug.keystore'), data);
      return cfg;
    },
  ]);
  return withAppBuildGradle(config, (cfg) => {
    let g = cfg.modResults.contents.replace(LEGACY, '\n');
    if (!/release\s*\{[\s\S]*?signingConfig signingConfigs\.debug/.test(g)) {
      throw new Error('build.gradle release no longer uses signingConfigs.debug');
    }
    cfg.modResults.contents = g;
    return cfg;
  });
};
