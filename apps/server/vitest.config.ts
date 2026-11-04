import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    env: {
      GIT_PROVIDER: 'local',
      K8S_ENABLED: 'false',
      AUTH_PROVIDERS: 'local',
      ENTRA_TENANT_ID: 'tenant-1',
      ENTRA_CLIENT_ID: 'client-1',
      ENTRA_CLIENT_SECRET: 'secret',
      PORT_CLIENT_ID: '',
      PORT_CLIENT_SECRET: '',
      NOTIFY_WEBHOOK_URL: '',
    },
    pool: 'forks',
    testTimeout: 15_000,
  },
});
