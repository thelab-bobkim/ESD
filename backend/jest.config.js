module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  setupFiles: ['<rootDir>/src/__tests__/env.setup.ts'],
  testMatch: ['<rootDir>/src/__tests__/**/*.test.ts'],
  testTimeout: 60000,
  maxWorkers: 1,
  forceExit: true,
};
