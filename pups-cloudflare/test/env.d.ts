import type { Env as PupsEnv } from '../src/settings'

// Types `env` from cloudflare:workers in tests.
declare global {
  namespace Cloudflare {
    interface Env extends PupsEnv {}
  }
}
