// Monorepo-aware Metro config (Expo auto-detects the workspace root).
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const LIB0_WEBCRYPTO = path.resolve(__dirname, 'src/shims/lib0-webcrypto.js');
// One copy of three.js, the ES module build (its CJS build calls Node's process.emitWarning, absent on Hermes).
const THREE_ESM = path.resolve(__dirname, '../../node_modules/three/build/three.module.js');

config.resolver.resolveRequest = (context, moduleName, platform) => {
  // Yjs → lib0/webcrypto: use our getRandomValues shim instead of isomorphic-webcrypto.
  if (moduleName === 'lib0/webcrypto') return { type: 'sourceFile', filePath: LIB0_WEBCRYPTO };
  if (moduleName === 'three') return { type: 'sourceFile', filePath: THREE_ESM };
  // react-native-webrtc needs event-target-shim v6 while React Native uses v5 (see react-native-webrtc README).
  if (moduleName.startsWith('event-target-shim') && context.originModulePath.includes('react-native-webrtc')) {
    return context.resolveRequest({ ...context, unstable_enablePackageExports: true }, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};
config.resolver.sourceExts.push('cjs');
config.resolver.assetExts.push('glb', 'wav', 'ogg');

// Production perf (D-perf): inline requires defer module init until first use (faster TTI, less startup RAM);
// the minifier drops console.log/info/debug calls but keeps console.error/warn, which errorLog.ts routes.
config.transformer.getTransformOptions = async () => ({
  transform: { experimentalImportSupport: false, inlineRequires: true },
});
config.transformer.minifierConfig = {
  ...config.transformer.minifierConfig,
  compress: {
    ...(config.transformer.minifierConfig && config.transformer.minifierConfig.compress),
    pure_funcs: ['console.log', 'console.info', 'console.debug'],
  },
};

module.exports = config;
