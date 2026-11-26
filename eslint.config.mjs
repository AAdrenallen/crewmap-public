// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/** Native-capability packages that may only be imported inside packages/platform (Section 2B boundary). */
const PLATFORM_ONLY = [
  'expo-location',
  'expo-task-manager',
  'expo-background-task',
  'expo-sensors',
  'expo-secure-store',
  'expo-battery',
  'expo-network',
  'expo-haptics',
  'expo-audio',
  'expo-speech',
  'react-native-webrtc',
  'react-native-libsodium',
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.tools/**',
      '**/.cache/**',
      '**/android/**',
      '**/.expo/**',
      '**/ios/**',
      '**/dist/**',
      '**/build/**',
      'tools/blender/**',
      '**/*.js',
      '**/*.cjs',
      '**/*.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-non-null-assertion': 'off',
      // React Native bundles static assets via require().
      '@typescript-eslint/no-require-imports': ['error', { allow: ['\\.(wav|ogg|png|webp|glb|ttf)$'] }],
      'no-restricted-imports': [
        'error',
        {
          paths: PLATFORM_ONLY.map((name) => ({ name, message: 'Platform-specific: use @crewmap/platform instead.' })),
          patterns: [
            { group: PLATFORM_ONLY.map((p) => `${p}/*`), message: 'Platform-specific: use @crewmap/platform instead.' },
            { group: ['@crewmap/platform/src/*'], message: 'Import the @crewmap/platform interface, not an implementation.' },
          ],
        },
      ],
    },
  },
  {
    // The platform package is the one place allowed to use native capability packages.
    files: ['packages/platform/**/*.{ts,tsx}'],
    rules: { 'no-restricted-imports': 'off' },
  },
);
