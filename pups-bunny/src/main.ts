import * as BunnySDK from '@bunny.net/edgescript-sdk'
import { handle } from './index'
import { envFrom } from './settings'

/** The Edge Script: a standalone script, the origin of its pull zone. */
declare const Deno: { env: { get(key: string): string | undefined } } | undefined
const env = envFrom(key => typeof Deno != 'undefined' ? Deno.env.get(key) : (globalThis as any).process?.env?.[key])

BunnySDK.net.http.serve(req => handle(req, env))
