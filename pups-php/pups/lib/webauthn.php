<?php
/**
 * Passkeys (WebAuthn), verified by hand with the openssl extension, so the drop-in needs no
 * library. Attestation is not checked (attestation type "none"): the owner registers the
 * passkey during setup, so its origin is known. Supported keys: ES256 and RS256 everywhere,
 * Ed25519 where PHP has the sodium extension.
 */

namespace Pups;

const CHALLENGE_TTL = 10 * 60_000;

/** The algorithms this PHP can verify, in order of preference (COSE identifiers). */
function passkeyAlgorithms(): array
{
    return array_merge([-7], function_exists('sodium_crypto_sign_verify_detached') ? [-8] : [], [-257]);
}

/** Options for navigator.credentials.create(), as JSON for owner.js. */
function passkeyCreateOptions(Config $c, State $state, array $existing = []): array
{
    $challenge = randomToken();
    $state->addChallenge($challenge, 'register', CHALLENGE_TTL);
    return [
        'challenge' => $challenge,
        'rp' => ['name' => "PUPS $c->host", 'id' => $c->rpId],
        'user' => ['id' => b64url(substr(hash('sha256', $c->origin, true), 0, 16)), 'name' => $c->host, 'displayName' => $c->host],
        'pubKeyCredParams' => array_map(fn($alg) => ['type' => 'public-key', 'alg' => $alg], passkeyAlgorithms()),
        'timeout' => 300_000,
        'attestation' => 'none',
        'authenticatorSelection' => ['residentKey' => 'preferred', 'userVerification' => 'required'],
        'excludeCredentials' => array_map(fn($p) => ['type' => 'public-key', 'id' => $p['id'], 'transports' => $p['transports']], $existing),
    ];
}

/** Options for navigator.credentials.get(), or null if the owner has no passkey. With `reuse`, the last options of this request. */
function passkeyGetOptions(Config $c, State $state, bool $reuse = false): ?array
{
    static $last = null;
    $passkeys = $state->owner()['passkeys'] ?? [];
    if (!$passkeys)
        return null;
    if ($reuse && $last)
        return $last;
    $challenge = randomToken();
    $state->addChallenge($challenge, 'auth', CHALLENGE_TTL);
    return $last = [
        'challenge' => $challenge,
        'rpId' => $c->rpId,
        'allowCredentials' => array_map(fn($p) => ['type' => 'public-key', 'id' => $p['id'], 'transports' => $p['transports']], $passkeys),
        'userVerification' => 'required',
        'timeout' => 120_000,
    ];
}

/** Checks clientDataJSON and authenticatorData shared by both ceremonies. Returns [clientData, authData parts]. */
function checkCeremony(array $response, string $type, string $purpose, Config $c, State $state): array
{
    $clientDataJson = fromB64url((string) ($response['response']['clientDataJSON'] ?? ''));
    $authData = fromB64url((string) ($response['response'][$type === 'webauthn.create' ? 'attestationObject' : 'authenticatorData'] ?? ''));
    $clientData = json_decode($clientDataJson ?? '', true);
    if (!is_array($clientData) || $authData === null)
        throw new \RuntimeException('Malformed passkey response');
    if (($clientData['type'] ?? null) !== $type)
        throw new \RuntimeException('Wrong ceremony type');
    if (!is_string($clientData['challenge'] ?? null) || !$state->takeChallenge($clientData['challenge'], $purpose))
        throw new \RuntimeException('The passkey request expired; try again');
    if (($clientData['origin'] ?? null) !== $c->origin)
        throw new \RuntimeException('Wrong origin');
    if ($type === 'webauthn.create') {
        $pos = 0;
        $att = cborDecode($authData, $pos);
        $authData = is_array($att) && is_string($att['authData'] ?? null) ? $att['authData'] : throw new \RuntimeException('Malformed attestation');
    }
    if (strlen($authData) < 37 || !hash_equals(hash('sha256', $c->rpId, true), substr($authData, 0, 32)))
        throw new \RuntimeException('Wrong relying party');
    $flags = ord($authData[32]);
    if (!($flags & 0x01) || !($flags & 0x04))
        throw new \RuntimeException('User presence and verification are required');
    return [$clientDataJson, $authData, $flags, unpack('N', substr($authData, 33, 4))[1]];
}

/** Verifies a registration (setup and passkey pages). Returns the passkey to store. Throws on failure. */
function verifyPasskeyRegistration(string $json, Config $c, State $state): array
{
    $response = json_decode($json, true);
    if (!is_array($response))
        throw new \RuntimeException('Invalid passkey registration');
    [, $authData, $flags, $counter] = checkCeremony($response, 'webauthn.create', 'register', $c, $state);
    if (!($flags & 0x40) || strlen($authData) < 55)
        throw new \RuntimeException('No credential in the registration');
    $idLength = unpack('n', substr($authData, 53, 2))[1];
    $id = substr($authData, 55, $idLength);
    $pos = 55 + $idLength;
    $cose = cborDecode($authData, $pos);
    [$alg, $key] = coseToKey(is_array($cose) ? $cose : []);
    $transports = $response['response']['transports'] ?? [];
    return [
        'id' => b64url($id), 'alg' => $alg, 'publicKey' => $key, 'counter' => $counter,
        'transports' => is_array($transports) ? array_values(array_filter($transports, fn($t) => is_string($t) && preg_match('/^[a-z-]{1,20}$/D', $t))) : [],
        'createdAt' => $state->now(),
    ];
}

/** Verifies an assertion against the owner's passkeys. Throws on failure. */
function verifyPasskeyAssertion(string $json, Config $c, State $state): void
{
    $response = json_decode($json, true);
    if (!is_array($response) || !is_string($response['id'] ?? null))
        throw new \RuntimeException('Invalid passkey response');
    $passkey = null;
    foreach ($state->owner()['passkeys'] ?? [] as $p)
        if ($p['id'] === $response['id'])
            $passkey = $p;
    if (!$passkey)
        throw new \RuntimeException('Unknown passkey');
    [$clientDataJson, $authData, , $counter] = checkCeremony($response, 'webauthn.get', 'auth', $c, $state);
    $signature = fromB64url((string) ($response['response']['signature'] ?? '')) ?? '';
    $signed = $authData . hash('sha256', $clientDataJson, true);
    $ok = $passkey['alg'] === -8
        ? function_exists('sodium_crypto_sign_verify_detached') && strlen($signature) === 64
            && sodium_crypto_sign_verify_detached($signature, $signed, fromB64url($passkey['publicKey']))
        : openssl_verify($signed, $signature, $passkey['publicKey'], OPENSSL_ALGO_SHA256) === 1;
    if (!$ok)
        throw new \RuntimeException('Invalid signature');
    if (!$state->updatePasskeyCounter($passkey['id'], $counter))
        throw new \RuntimeException('The signature counter went backwards; the passkey may have been cloned');
}

/** A COSE public key → [alg, PEM (or base64url raw key for Ed25519)]. */
function coseToKey(array $k): array
{
    $kty = $k[1] ?? null;
    $alg = $k[3] ?? null;
    if ($kty === 2 && $alg === -7 && ($k[-1] ?? null) === 1 && strlen($k[-2] ?? '') === 32 && strlen($k[-3] ?? '') === 32)
        return [-7, pem(der(0x30, der(0x30, der(0x06, hex2bin('2a8648ce3d0201')) . der(0x06, hex2bin('2a8648ce3d030107')))
            . der(0x03, "\0\x04" . $k[-2] . $k[-3])))];
    if ($kty === 3 && $alg === -257 && is_string($k[-1] ?? null) && is_string($k[-2] ?? null))
        return [-257, pem(der(0x30, der(0x30, der(0x06, hex2bin('2a864886f70d010101')) . "\x05\x00")
            . der(0x03, "\0" . der(0x30, derInt($k[-1]) . derInt($k[-2])))))];
    if ($kty === 1 && $alg === -8 && ($k[-1] ?? null) === 6 && strlen($k[-2] ?? '') === 32 && in_array(-8, passkeyAlgorithms(), true))
        return [-8, b64url($k[-2])];
    throw new \RuntimeException('Unsupported passkey algorithm');
}

function der(int $tag, string $content): string
{
    $n = strlen($content);
    $len = $n < 128 ? chr($n) : chr(0x80 | strlen(ltrim(pack('N', $n), "\0"))) . ltrim(pack('N', $n), "\0");
    return chr($tag) . $len . $content;
}

function derInt(string $bytes): string
{
    $bytes = ltrim($bytes, "\0");
    return der(0x02, $bytes === '' || ord($bytes[0]) & 0x80 ? "\0$bytes" : $bytes);
}

function pem(string $der): string
{
    return "-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode($der), 64, "\n") . "-----END PUBLIC KEY-----\n";
}

/** Decodes one CBOR item at `pos` (definite lengths only, as authenticators send). */
function cborDecode(string $data, int &$pos, int $depth = 0): mixed
{
    if ($pos >= strlen($data) || $depth > 16)
        throw new \RuntimeException('Malformed CBOR');
    $b = ord($data[$pos++]);
    $major = $b >> 5;
    $info = $b & 31;
    $read = function (int $n) use ($data, &$pos) {
        if ($pos + $n > strlen($data))
            throw new \RuntimeException('Malformed CBOR');
        $s = substr($data, $pos, $n);
        $pos += $n;
        return $s;
    };
    if ($major === 7)
        return match ($info) { 20 => false, 21 => true, 22, 23 => null, default => throw new \RuntimeException('Unsupported CBOR value') };
    $len = match (true) {
        $info < 24 => $info,
        $info === 24 => ord($read(1)),
        $info === 25 => unpack('n', $read(2))[1],
        $info === 26 => unpack('N', $read(4))[1],
        $info === 27 => unpack('J', $read(8))[1],
        default => throw new \RuntimeException('Unsupported CBOR length'),
    };
    switch ($major) {
        case 0:
            return $len;
        case 1:
            return -1 - $len;
        case 2:
        case 3:
            return $read($len);
        case 4:
            if ($len > 1000)
                throw new \RuntimeException('Malformed CBOR');
            $out = [];
            for ($i = 0; $i < $len; $i++)
                $out[] = cborDecode($data, $pos, $depth + 1);
            return $out;
        case 5:
            if ($len > 1000)
                throw new \RuntimeException('Malformed CBOR');
            $out = [];
            for ($i = 0; $i < $len; $i++) {
                $k = cborDecode($data, $pos, $depth + 1);
                if (!is_int($k) && !is_string($k))
                    throw new \RuntimeException('Unsupported CBOR map key');
                $out[$k] = cborDecode($data, $pos, $depth + 1);
            }
            return $out;
        default:
            throw new \RuntimeException('Unsupported CBOR type');
    }
}
