import { HttpError } from './http';

export interface FileType {
    /** The type the file is always served with. */
    served: string;
    /** Upload Content-Types accepted for the extension. */
    accepted: string[];
    /** Text files must be UTF-8 and are served with `charset=utf-8`. */
    text?: boolean;
}

/** The fixed allowlist of RFC-6 "File types". The extension decides the type. */
export const FILE_TYPES: Record<string, FileType> = {
    json: { served: 'application/json', accepted: ['application/json', 'application/feed+json'], text: true },
    xml: { served: 'application/xml', accepted: ['application/xml', 'text/xml', 'application/rss+xml', 'application/atom+xml'], text: true },
    opml: { served: 'text/x-opml', accepted: ['text/x-opml', 'application/xml', 'text/xml'], text: true },
    md: { served: 'text/markdown', accepted: ['text/markdown', 'text/x-markdown'], text: true },
    txt: { served: 'text/plain', accepted: ['text/plain'], text: true },
    csv: { served: 'text/csv', accepted: ['text/csv'], text: true },
    vcf: { served: 'text/vcard', accepted: ['text/vcard', 'text/x-vcard'], text: true },
    svg: { served: 'image/svg+xml', accepted: ['image/svg+xml'], text: true },
    png: { served: 'image/png', accepted: ['image/png'] },
    jpg: { served: 'image/jpeg', accepted: ['image/jpeg'] },
    jpeg: { served: 'image/jpeg', accepted: ['image/jpeg'] },
    gif: { served: 'image/gif', accepted: ['image/gif'] },
    webp: { served: 'image/webp', accepted: ['image/webp'] },
    avif: { served: 'image/avif', accepted: ['image/avif'] },
    mp3: { served: 'audio/mpeg', accepted: ['audio/mpeg'] },
    m4a: { served: 'audio/mp4', accepted: ['audio/mp4', 'audio/x-m4a'] },
    ogg: { served: 'audio/ogg', accepted: ['audio/ogg', 'audio/opus'] },
    opus: { served: 'audio/ogg', accepted: ['audio/ogg', 'audio/opus'] },
    mp4: { served: 'video/mp4', accepted: ['video/mp4', 'audio/mp4'] },
    webm: { served: 'video/webm', accepted: ['video/webm', 'audio/webm'] },
};

/**
 * Never accepted anywhere, in any position of the file name: web content and
 * server-executable or server-config files. The allowlist already excludes them as the
 * final extension; this list catches `feed.php.json`, which Apache's mod_mime would execute.
 */
export const BLOCKED_EXTENSIONS = new Set([
    'html', 'htm', 'xhtml', 'js', 'mjs', 'css',
    'php', 'phtml', 'php3', 'php4', 'php5', 'php6', 'php7', 'php8', 'phar', 'pht', 'phps', 'inc',
    'jsp', 'jspx', 'asp', 'aspx', 'cgi', 'pl', 'py', 'rb', 'sh', 'shtml', 'htaccess', 'htpasswd',
]);

const extensions = (path: string) => path.slice(path.lastIndexOf('/') + 1).toLowerCase().split('.').slice(1);

/** The file type for a path, or undefined if its extension is not allowed. */
export function fileType(path: string): FileType | undefined {
    const exts = extensions(path);
    const last = exts.at(-1);
    if (!last || exts.some(e => BLOCKED_EXTENSIONS.has(e)) || !Object.hasOwn(FILE_TYPES, last))
        return;
    return FILE_TYPES[last];
}

/** The Content-Type a file is served with. */
export const servedType = (t: FileType) => t.text ? `${t.served}; charset=utf-8` : t.served;

/** Checks the extension and the upload's Content-Type. Throws 415. */
export function checkUploadType(path: string, contentType: string | undefined): FileType {
    const t = fileType(path);
    if (!t) {
        const blocked = extensions(path).find(e => BLOCKED_EXTENSIONS.has(e));
        throw new HttpError(415, 'unsupported_type', blocked
            ? `Files with the extension .${blocked} are never accepted, in any position of the name`
            : 'The file extension is not on the allowlist');
    }
    const media = contentType?.split(';')[0].trim().toLowerCase();
    if (!media || !t.accepted.includes(media))
        throw new HttpError(415, 'unsupported_type', `Content-Type must be one of: ${t.accepted.join(', ')}`);
    return t;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Text files must be UTF-8. Throws 415. */
export function checkUtf8(t: FileType, body: Buffer) {
    if (!t.text)
        return;
    try {
        utf8.decode(body);
    } catch {
        throw new HttpError(415, 'unsupported_type', 'Text files must be UTF-8');
    }
}
