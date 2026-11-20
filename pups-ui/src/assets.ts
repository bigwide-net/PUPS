/**
 * The stylesheet and script of the owner pages as text, for servers that serve them from code
 * (Bunny). Servers with static assets (Cloudflare) serve public/pups/assets/ directly.
 * Needs `?raw` imports: Vite in tests, an esbuild plugin in builds (see src/raw.d.ts).
 */
import ownerCss from '../public/pups/assets/owner.css?raw'
import ownerJs from '../public/pups/assets/owner.js?raw'

export { ownerCss, ownerJs }
