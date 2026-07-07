module.exports = {
  preset: 'react-native',
  // Coverage is scoped to the pure-logic modules unit tests can actually
  // verify. Screens, Supernote API adapters, and native-module wrappers are
  // device-integration code, verified on-device per iteration instead.
  collectCoverageFrom: [
    'src/domain/**/*.{ts,tsx}',
    'src/storage/nativeShelfStorage.ts',
    '!src/**/*.d.ts',
    '!src/**/.gitkeep',
  ],
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 70,
      lines: 70,
      statements: 70,
    },
  },
};
