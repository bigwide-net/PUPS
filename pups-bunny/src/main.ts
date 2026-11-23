import * as BunnySDK from '@bunny.net/edgescript-sdk'
import { handle } from './index'
import { envFrom } from './settings'

/** The Edge Script: a standalone script, the origin of its pull zone. */
declare const Deno: { env: { get(key: string): string | undefined } } | undefined
const env = envFrom(key => typeof Deno != 'undefined' ? Deno.env.get(key) : (globalThis as any).process?.env?.[key])

// Work after the response, such as checking webmentions (https://docs.bunny.net/docs/scripting/runtime).
declare const Bunny: { v1?: { waitUntil?(work: Promise<unknown>): void } } | undefined
const waitUntil = typeof Bunny != 'undefined' ? Bunny.v1?.waitUntil : undefined
if (waitUntil) env.waitUntil = work => waitUntil(work)

BunnySDK.net.http.serve(req => handle(req, env))
