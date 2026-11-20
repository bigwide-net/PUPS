import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          OWNER_HOST: 'tim.example.com',
          BOOTSTRAP_SECRET: 'test-bootstrap-secret',
          WRITES_PER_MINUTE: '1000',
          MAX_UPLOAD_BYTES: '1048576',
          POST_FALLBACK: 'true',
        },
      },
    }),
  ],
})
