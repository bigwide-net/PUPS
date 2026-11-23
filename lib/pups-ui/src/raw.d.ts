/** Text imports (`?raw`): Vite in the tests, the esbuild plugin in scripts/build.mjs. */
declare module '*?raw' {
  const text: string
  export default text
}
