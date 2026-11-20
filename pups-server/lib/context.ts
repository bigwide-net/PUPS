import { ClientLoader } from './cimd';
import { PupsConfig } from './config';
import { OwnerAuth } from './owner';
import { State } from './state';
import { FileStore } from './storage';

/** Everything the handlers share. */
export interface Ctx {
    config: PupsConfig;
    state: State;
    files: FileStore;
    clients: ClientLoader;
    owner: OwnerAuth;
}
