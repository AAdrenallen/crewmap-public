// Many native modules (Mapbox, WebRTC, libsodium, Reanimated): give Gradle/Kotlin enough heap.
const { withGradleProperties } = require('expo/config-plugins');

module.exports = function withGradleMemory(config) {
  return withGradleProperties(config, (cfg) => {
    const set = (key, value) => {
      const item = cfg.modResults.find((p) => p.type === 'property' && p.key === key);
      if (item) item.value = value;
      else cfg.modResults.push({ type: 'property', key, value });
    };
    set('org.gradle.jvmargs', '-Xmx6g -XX:MaxMetaspaceSize=1g -Dfile.encoding=UTF-8');
    set('org.gradle.caching', 'true');
    set('kotlin.daemon.jvmargs', '-Xmx3g');
    return cfg;
  });
};
