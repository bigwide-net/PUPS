import { PupsConfig } from './config';
import { safeEqual } from './crypto';
import { log } from './log';

const WINDOW = 15 * 60_000;
const FREE_FAILURES = 5;

/**
 * Owner authentication: the password from PUPS_PASSWORD, confirmed with every owner action.
 * The server runs in same-domain mode only, so it never sets a cookie (RFC-6 "Deployment
 * modes"). Failed attempts are rate-limited: 5 per 15 minutes, then one per minute.
 */
export class OwnerAuth {
    private password: string;
    private failures: number[] = [];

    constructor(config: PupsConfig) {
        this.password = config.password;
    }

    /** Checks a password for an owner action (logged). Returns an error message, or undefined if it is correct. */
    check(password: string | undefined, action: string, details: Record<string, unknown> = {}): string | undefined {
        const now = Date.now();
        this.failures = this.failures.filter(t => t > now - WINDOW);
        if (this.failures.length >= FREE_FAILURES) {
            const wait = this.failures.at(-1)! + 60_000 - now;
            if (wait > 0) {
                log('login.blocked', { action, ...details, retryInSeconds: Math.ceil(wait / 1000) });
                return `Too many failed attempts. Try again in ${Math.ceil(wait / 1000)} seconds.`;
            }
        }
        if (password && safeEqual(password, this.password)) {
            log('login.ok', { action, ...details });
            return;
        }
        this.failures.push(now);
        log('login.failed', { action, ...details, reason: password ? 'wrong password' : 'no password', recentFailures: this.failures.length });
        return 'Wrong password.';
    }
}
