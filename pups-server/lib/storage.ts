import fs from 'fs';
import path from 'path';
import { randomToken, sha256 } from './crypto';

export interface FileInfo {
    abs: string;
    size: number;
    mtime: Date;
    /** Quoted strong ETag: the SHA-256 of the content. */
    etag: string;
}

/**
 * Uploaded files on the local disk: storage path `/a/b.json` is `<root>/a/b.json`. Paths are
 * validated before they get here; this class also makes sure that no symbolic link leads
 * out of the root. All methods are synchronous, so a precondition check followed by a
 * write can't be interleaved with another request.
 */
export class FileStore {
    private root: string;
    private realRoot: string;
    /** ETags by file, valid while size and mtime are unchanged. */
    private etags = new Map<string, { size: number; mtimeMs: number; etag: string }>();

    constructor(root: string) {
        fs.mkdirSync(root, { recursive: true });
        this.root = root;
        this.realRoot = fs.realpathSync(root);
    }

    /** The absolute file name of a storage path, after checking that it stays inside the root. */
    private abs(storagePath: string): string {
        const abs = path.join(this.root, storagePath.slice(1));
        let existing = abs;
        while (!fs.existsSync(existing))
            existing = path.dirname(existing);
        const real = fs.realpathSync(existing);
        if (real != this.realRoot && !real.startsWith(this.realRoot + path.sep))
            throw new Error(`Storage path leads out of the storage directory: ${storagePath}`);
        return abs;
    }

    stat(storagePath: string): FileInfo | undefined {
        const abs = this.abs(storagePath);
        let st: fs.Stats;
        try {
            st = fs.lstatSync(abs);
        } catch {
            return;
        }
        if (!st.isFile())
            return;
        const cached = this.etags.get(abs);
        const etag = cached?.size == st.size && cached.mtimeMs == st.mtimeMs ? cached.etag : `"${sha256(fs.readFileSync(abs))}"`;
        this.etags.set(abs, { size: st.size, mtimeMs: st.mtimeMs, etag });
        return { abs, size: st.size, mtime: st.mtime, etag };
    }

    read(storagePath: string): Buffer | undefined {
        const info = this.stat(storagePath);
        return info && fs.readFileSync(info.abs);
    }

    /** Writes atomically (temp file + rename) and returns the new ETag. */
    write(storagePath: string, body: Buffer | string): string {
        const abs = this.abs(storagePath);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        // Temp files start with a dot, so they can never be read or written through the API.
        const tmp = path.join(path.dirname(abs), `.pups-${randomToken(6)}.tmp`);
        fs.writeFileSync(tmp, body);
        fs.renameSync(tmp, abs);
        const st = fs.statSync(abs);
        const etag = `"${sha256(body)}"`;
        this.etags.set(abs, { size: st.size, mtimeMs: st.mtimeMs, etag });
        return etag;
    }

    delete(storagePath: string) {
        const abs = this.abs(storagePath);
        fs.unlinkSync(abs);
        this.etags.delete(abs);
    }

    /** Deletes a whole directory, e.g. an app's `/appdata/<client-host>/`. */
    deleteDir(storagePath: string) {
        fs.rmSync(this.abs(storagePath), { recursive: true, force: true });
    }
}
