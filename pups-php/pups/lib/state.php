<?php

namespace Pups;

const CODE_TTL = 60_000;
const ACCESS_TTL = 3600_000;
const REFRESH_TTL = 180 * 24 * 3600_000;
/** How long a replaced refresh token can be retried while its successors are unused (RFC-6 "Grace period"). */
const REFRESH_GRACE = 60_000;
/** Used codes are kept this long after they expire, so that reuse is still detected. */
const CODE_KEEP = 24 * 3600_000;
const LOGIN_WINDOW = 15 * 60_000;
const LOGIN_FREE_FAILURES = 5;

/** Identify-only grants get no refresh token: there is nothing to refresh for. */
function wantsRefresh(string $scope): bool
{
    return (bool) array_filter(explode(' ', $scope), fn($x) => $x !== 'identify');
}

/**
 * All state of the installation in one JSON file, data/state.json: the owner's credentials,
 * grants, hashed tokens and codes, rate limits. PHP handles requests in parallel, so every
 * method runs as a transaction: it takes an exclusive lock (flock on data/state.lock),
 * reads the file, changes it and writes it back atomically (temp file + rename). A code can
 * therefore be redeemed only once, a refresh token rotated only once.
 *
 * Tokens and codes are stored only as SHA-256 hashes.
 */
final class State
{
    private string $file;
    /** @var callable(): int */
    private $clock;
    private ?array $d = null;

    public function __construct(string $dataDir, callable $clock)
    {
        $this->file = "$dataDir/state.json";
        $this->clock = $clock;
    }

    public function now(): int
    {
        return ($this->clock)();
    }

    /** Runs `fn` with the state loaded and locked; saves it if it changed. Re-entrant. */
    private function tx(callable $fn): mixed
    {
        if ($this->d !== null)
            return $fn();
        $lock = fopen(dirname($this->file) . '/state.lock', 'c');
        if (!$lock || !flock($lock, LOCK_EX))
            throw new \RuntimeException('Cannot lock the state file');
        try {
            $text = is_file($this->file) ? file_get_contents($this->file) : '';
            $loaded = $text === '' ? [] : json_decode($text, true, 512, JSON_THROW_ON_ERROR);
            $this->d = $loaded + [
                'secret' => randomToken(), 'owner' => null, 'grants' => [], 'codes' => [], 'accessTokens' => [],
                'refreshTokens' => [], 'approvedClients' => [], 'usedNonces' => [], 'challenges' => [],
                'loginFailures' => [], 'writeCounters' => [],
            ];
            $result = $fn();
            $this->prune();
            $json = json_encode($this->d, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
            if ($json !== $text)
                writeAtomic($this->file, $json);
            return $result;
        } finally {
            $this->d = null;
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }

    /** Removes expired records. */
    private function prune(): void
    {
        $now = $this->now();
        $d = &$this->d;
        $d['codes'] = array_filter($d['codes'], fn($c) => $c['expiresAt'] + CODE_KEEP >= $now);
        $d['accessTokens'] = array_filter($d['accessTokens'], fn($t) => $t['expiresAt'] >= $now && isset($d['grants'][$t['grantId']]));
        $d['refreshTokens'] = array_filter($d['refreshTokens'], fn($t) => $t['expiresAt'] >= $now && isset($d['grants'][$t['grantId']]));
        $d['usedNonces'] = array_filter($d['usedNonces'], fn($exp) => $exp >= $now);
        $d['challenges'] = array_filter($d['challenges'], fn($c) => $c['expiresAt'] >= $now);
        $d['loginFailures'] = array_values(array_filter($d['loginFailures'], fn($t) => $t > $now - 24 * 3600_000));
        $minute = intdiv($now, 60_000);
        $d['writeCounters'] = array_filter($d['writeCounters'], fn($c) => $c[0] >= $minute - 1);
    }

    /** The HMAC key for signed form fields. */
    public function secret(): string
    {
        return $this->tx(fn() => $this->d['secret']);
    }

    // --- Owner ---------------------------------------------------------------------------

    /** ['passwordHash' => ?string, 'passkeys' => list, 'createdAt' => int] or null before setup. */
    public function owner(): ?array
    {
        return $this->tx(fn() => $this->d['owner']);
    }

    /** Creates the owner. False if it exists already (setup is single-use). */
    public function createOwner(?string $passwordHash, ?array $passkey): bool
    {
        return $this->tx(function () use ($passwordHash, $passkey) {
            if ($this->d['owner'] || (!$passwordHash && !$passkey))
                return false;
            $this->d['owner'] = ['passwordHash' => $passwordHash, 'passkeys' => $passkey ? [$passkey] : [], 'createdAt' => $this->now()];
            return true;
        });
    }

    public function setPassword(string $hash): void
    {
        $this->tx(function () use ($hash) {
            $this->d['owner']['passwordHash'] = $hash;
        });
    }

    public function addPasskey(array $passkey): void
    {
        $this->tx(function () use ($passkey) {
            $this->d['owner']['passkeys'][] = $passkey;
        });
    }

    public function removePasskey(string $id): bool
    {
        return $this->tx(function () use ($id) {
            $before = count($this->d['owner']['passkeys']);
            $this->d['owner']['passkeys'] = array_values(array_filter($this->d['owner']['passkeys'], fn($p) => $p['id'] !== $id));
            return count($this->d['owner']['passkeys']) !== $before;
        });
    }

    /** Stores a passkey's new signature counter. False if it didn't increase (a cloned authenticator). */
    public function updatePasskeyCounter(string $id, int $counter): bool
    {
        return $this->tx(function () use ($id, $counter) {
            foreach ($this->d['owner']['passkeys'] as &$p)
                if ($p['id'] === $id) {
                    if (($counter || $p['counter']) && $counter <= $p['counter'])
                        return false;
                    $p['counter'] = $counter;
                    $p['lastUsedAt'] = $this->now();
                }
            return true;
        });
    }

    // --- Challenges, nonces and login rate limiting ---------------------------------------

    /** Stores a WebAuthn challenge. Every owner page makes one, so only the newest 100 are kept. */
    public function addChallenge(string $challenge, string $purpose, int $ttl): void
    {
        $this->tx(function () use ($challenge, $purpose, $ttl) {
            $this->d['challenges'][$challenge] = ['purpose' => $purpose, 'expiresAt' => $this->now() + $ttl];
            $this->d['challenges'] = array_slice($this->d['challenges'], -100, null, true);
        });
    }

    /** Consumes a WebAuthn challenge. True if it existed, was unexpired and had this purpose. */
    public function takeChallenge(string $challenge, string $purpose): bool
    {
        return $this->tx(function () use ($challenge, $purpose) {
            $c = $this->d['challenges'][$challenge] ?? null;
            unset($this->d['challenges'][$challenge]);
            return $c && $c['purpose'] === $purpose && $c['expiresAt'] > $this->now();
        });
    }

    /** Marks a nonce as used. False if it was used before. */
    public function useNonce(string $nonce, int $expiresAt): bool
    {
        return $this->tx(function () use ($nonce, $expiresAt) {
            if (isset($this->d['usedNonces'][$nonce]))
                return false;
            $this->d['usedNonces'][$nonce] = $expiresAt;
            return true;
        });
    }

    /** Milliseconds until the next login attempt is allowed; 0 if allowed now. */
    public function loginDelay(): int
    {
        return $this->tx(function () {
            $now = $this->now();
            $all = $this->d['loginFailures'];
            $recent = array_filter($all, fn($t) => $t > $now - LOGIN_WINDOW);
            if (count($recent) < LOGIN_FREE_FAILURES)
                return 0;
            // 5 failures in 15 minutes, then growing delays: 1, 2, 4, … minutes, at most a day.
            $delay = min(60_000 * 2 ** max(0, count($all) - LOGIN_FREE_FAILURES), 24 * 3600_000);
            return max(0, end($all) + $delay - $now);
        });
    }

    public function loginFailed(): int
    {
        return $this->tx(function () {
            $this->d['loginFailures'][] = $this->now();
            return count($this->d['loginFailures']);
        });
    }

    public function loginSucceeded(): void
    {
        $this->tx(function () {
            $this->d['loginFailures'] = [];
        });
    }

    public function clientApproved(string $clientId): bool
    {
        return $this->tx(fn() => isset($this->d['approvedClients'][$clientId]));
    }

    // --- Codes and grants ----------------------------------------------------------------

    /** Stores a new authorization code and returns it. */
    public function createCode(array $data): string
    {
        return $this->tx(function () use ($data) {
            $code = randomToken();
            $now = $this->now();
            $this->d['codes'][hashToken($code)] = $data + ['expiresAt' => $now + CODE_TTL, 'usedAt' => null];
            $this->d['approvedClients'][$data['clientId']] ??= $now;
            return $code;
        });
    }

    private function issueTokens(string $grantId, bool $withRefresh): array
    {
        $now = $this->now();
        $access = randomToken();
        $refresh = $withRefresh ? randomToken() : null;
        $hashes = ['access' => hashToken($access), 'refresh' => $refresh === null ? null : hashToken($refresh)];
        $this->d['accessTokens'][$hashes['access']] = ['grantId' => $grantId, 'expiresAt' => $now + ACCESS_TTL, 'used' => false];
        if ($refresh !== null)
            $this->d['refreshTokens'][$hashes['refresh']] = ['grantId' => $grantId, 'expiresAt' => $now + REFRESH_TTL, 'replacedAt' => null, 'successor' => null];
        return [['access' => $access, 'refresh' => $refresh], $hashes];
    }

    /**
     * Redeems a code. A code is single-use: any second attempt fails and revokes the grant
     * (and so every token) issued from it.
     * Returns ['ok' => true, 'grant', 'tokens'] or ['ok' => false, 'description'].
     */
    public function redeemCode(string $code, string $clientId, string $redirectUri, string $challenge): array
    {
        return $this->tx(function () use ($code, $clientId, $redirectUri, $challenge) {
            $now = $this->now();
            $codeHash = hashToken($code);
            $c = &$this->d['codes'][$codeHash];
            $fail = fn(string $description) => ['ok' => false, 'description' => $description];
            if (!$c) {
                unset($this->d['codes'][$codeHash]);
                return $fail('Unknown authorization code');
            }
            if ($c['usedAt']) {
                foreach ($this->d['grants'] as $g)
                    if ($g['codeHash'] === $codeHash)
                        unset($this->d['grants'][$g['id']]);
                return $fail('The authorization code was already used; tokens issued from it are revoked');
            }
            $c['usedAt'] = $now;
            if ($c['expiresAt'] < $now)
                return $fail('The authorization code has expired');
            if ($c['clientId'] !== $clientId)
                return $fail('client_id does not match the authorization request');
            if ($c['redirectUri'] !== $redirectUri)
                return $fail('redirect_uri does not match the authorization request');
            if (!hash_equals($c['codeChallenge'], $challenge))
                return $fail('PKCE verification failed');
            $grant = [
                'id' => randomToken(16), 'clientId' => $clientId, 'clientHost' => $c['clientHost'], 'clientName' => $c['clientName'],
                'scope' => $c['scope'], 'codeHash' => $codeHash, 'createdAt' => $now, 'lastUsedAt' => null,
            ];
            $this->d['grants'][$grant['id']] = $grant;
            [$tokens] = $this->issueTokens($grant['id'], wantsRefresh($c['scope']));
            return ['ok' => true, 'grant' => $grant, 'tokens' => $tokens];
        });
    }

    /** Has anything issued by a refresh been used: the new refresh token or the new access token? */
    private function successorUsed(?array $s): bool
    {
        $access = $s ? ($this->d['accessTokens'][$s['access']] ?? null) : null;
        $refresh = $s && $s['refresh'] ? ($this->d['refreshTokens'][$s['refresh']] ?? null) : null;
        return !$access || !$refresh || $access['used'] || $refresh['replacedAt'];
    }

    /**
     * Rotates a refresh token (RFC-6 "Refresh"). Reusing a token that was already replaced
     * revokes the whole grant, because it means the token was copied, except during the
     * grace period while nothing issued by the replacement has been used: then the unused
     * successors are revoked and a fresh pair is issued.
     * Returns ['ok' => true, 'grant', 'tokens', 'graceRetry'] or ['ok' => false, 'reason', 'revoked' => ?grant].
     */
    public function refresh(string $refreshToken, string $clientId): array
    {
        return $this->tx(function () use ($refreshToken, $clientId) {
            $now = $this->now();
            $hash = hashToken($refreshToken);
            $r = $this->d['refreshTokens'][$hash] ?? null;
            $grant = $r ? ($this->d['grants'][$r['grantId']] ?? null) : null;
            if (!$grant)
                return ['ok' => false, 'reason' => 'unknown or revoked refresh token', 'revoked' => null];
            if ($grant['clientId'] !== $clientId)
                return ['ok' => false, 'reason' => "refresh token belongs to {$grant['clientId']}", 'revoked' => null];
            if ($r['expiresAt'] < $now)
                return ['ok' => false, 'reason' => 'refresh token expired', 'revoked' => null];
            $graceRetry = (bool) $r['replacedAt'];
            if ($r['replacedAt']) {
                $late = $now - $r['replacedAt'] > REFRESH_GRACE;
                if ($late || $this->successorUsed($r['successor'])) {
                    unset($this->d['grants'][$grant['id']]);
                    return ['ok' => false, 'revoked' => $grant, 'reason' => 'replaced refresh token reused ' . ($late
                        ? round(($now - $r['replacedAt']) / 1000) . ' s after its replacement (grace period ' . REFRESH_GRACE / 1000 . ' s)'
                        : 'after its successor was used')];
                }
                unset($this->d['accessTokens'][$r['successor']['access']], $this->d['refreshTokens'][$r['successor']['refresh']]);
            } else
                $this->d['refreshTokens'][$hash]['replacedAt'] = $now;
            [$tokens, $hashes] = $this->issueTokens($grant['id'], true);
            $this->d['refreshTokens'][$hash]['successor'] = $hashes;
            return ['ok' => true, 'grant' => $grant, 'tokens' => $tokens, 'graceRetry' => $graceRetry];
        });
    }

    /**
     * RFC 7009 revocation. An access token is revoked alone; a refresh token revokes its
     * grant, which is returned so the caller can clean up.
     */
    public function revokeToken(string $token, string $clientId): ?array
    {
        return $this->tx(function () use ($token, $clientId) {
            $hash = hashToken($token);
            if ($a = $this->d['accessTokens'][$hash] ?? null) {
                if (($this->d['grants'][$a['grantId']]['clientId'] ?? null) === $clientId)
                    unset($this->d['accessTokens'][$hash]);
                return null;
            }
            $r = $this->d['refreshTokens'][$hash] ?? null;
            $g = $r ? ($this->d['grants'][$r['grantId']] ?? null) : null;
            return $g && $g['clientId'] === $clientId ? $this->revokeGrant($g['id']) : null;
        });
    }

    /** Revokes a grant and all its tokens (they are pruned on save). Returns the revoked grant. */
    public function revokeGrant(string $grantId): ?array
    {
        return $this->tx(function () use ($grantId) {
            $g = $this->d['grants'][$grantId] ?? null;
            unset($this->d['grants'][$grantId]);
            return $g;
        });
    }

    public function clientHasGrant(string $clientId): bool
    {
        return $this->tx(fn() => (bool) array_filter($this->d['grants'], fn($g) => $g['clientId'] === $clientId));
    }

    /** All grants, newest first. */
    public function activeGrants(): array
    {
        return $this->tx(function () {
            $grants = array_values($this->d['grants']);
            usort($grants, fn($a, $b) => $b['createdAt'] <=> $a['createdAt']);
            return $grants;
        });
    }

    /**
     * Looks up an access token at the upload API and marks it as used. With `writesPerMinute`,
     * also counts a write against the grant's rate limit.
     * Returns ['grant', 'rateLimited'] or null.
     */
    public function authenticate(string $accessToken, int $writesPerMinute = 0): ?array
    {
        return $this->tx(function () use ($accessToken, $writesPerMinute) {
            $now = $this->now();
            $hash = hashToken($accessToken);
            $t = $this->d['accessTokens'][$hash] ?? null;
            $grant = $t && $t['expiresAt'] > $now ? ($this->d['grants'][$t['grantId']] ?? null) : null;
            if (!$grant)
                return null;
            // Saved at once when the token is first used (the refresh grace period depends on it), else
            // at most once a minute, so that fresh reads don't write the state file every time.
            if (!$t['used'] || $now - ($grant['lastUsedAt'] ?? 0) > 60_000) {
                $this->d['accessTokens'][$hash]['used'] = true;
                $this->d['grants'][$grant['id']]['lastUsedAt'] = $now;
            }
            $rateLimited = false;
            if ($writesPerMinute) {
                $minute = intdiv($now, 60_000);
                $c = $this->d['writeCounters'][$grant['id']] ?? [$minute, 0];
                $c = $c[0] === $minute ? [$minute, $c[1] + 1] : [$minute, 1];
                $this->d['writeCounters'][$grant['id']] = $c;
                $rateLimited = $c[1] > $writesPerMinute;
            }
            return ['grant' => $grant, 'rateLimited' => $rateLimited];
        });
    }
}

/** Writes a file atomically: a temp file in the same directory, then rename. */
function writeAtomic(string $file, string $content, int $mode = 0600): void
{
    $dir = dirname($file);
    if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir))
        throw new \RuntimeException("Cannot create the directory $dir");
    $tmp = "$dir/." . basename($file) . '.' . randomToken(6) . '.tmp';
    if (file_put_contents($tmp, $content) === false)
        throw new \RuntimeException("Cannot write $tmp");
    @chmod($tmp, $mode);
    if (!rename($tmp, $file)) {
        @unlink($tmp);
        throw new \RuntimeException("Cannot write $file");
    }
}
