import texts from '../texts.json'

export type TextKey = Exclude<keyof typeof texts, '_about'>

/**
 * A text from texts.json, which PHP reads too, with its {placeholders} replaced. The values
 * are inserted as they are: escaped HTML for HTML texts, plain text for title.* texts.
 */
export const t = (key: TextKey, vars: Record<string, string> = {}) =>
  texts[key].replace(/\{(\w+)\}/g, (m, name: string) => vars[name] ?? m)
