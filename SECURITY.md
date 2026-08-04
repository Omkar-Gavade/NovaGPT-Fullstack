# Security

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private vulnerability reporting on
this repository, or email the maintainers.

Expect an acknowledgement within three working days and an assessment within
ten. If a fix takes longer than that, you will get the reason rather than
silence.

Please include what you would want if you were fixing it: the version or commit,
what an attacker gains, and the smallest reproduction you have. A proof of
concept against your own deployment is welcome; one against someone else's is
not.

## What is in scope

The three assets, in the order an attacker would value them
([10 — Security](docs/backend/10-security.md)):

1. **Provider API keys.** Directly monetisable. A leaked paid key is someone
   else's bill; a leaked free key is a burned quota and a terminated account.
2. **Conversation content.** Users paste code, credentials and business plans
   into chat.
3. **Provider quota.** Not a secret, but finite and shared. Burning the fleet's
   daily quota denies service to every user without breaching anything — which
   is what makes abuse as damaging as intrusion here, and is unusual enough to
   be worth stating.

Anything that reaches one of those is in scope, including paths that look
harmless: a serialiser that spreads an internal object, an error body carrying a
`cause`, a log line at debug level.

## What is out of scope

- Findings against a deployment that has disabled its own controls —
  `AUTH_REQUIRED=false` is refused in production by configuration validation,
  and a deployment that bypassed that is describing its own configuration.
- Rate limits being reachable. They are, deliberately: the limits shed load,
  they do not hide the endpoint.
- Missing headers with no demonstrated impact.
- Volumetric denial of service.

## What is already known, and deliberate

Stating these saves everyone a round trip:

| Behaviour | Why |
|---|---|
| A shared conversation is readable with no account | The link **is** the grant. Requiring an account would break every link already sent |
| Another user's resource returns **404**, not 403 | A 403 confirms it exists, which permits enumeration |
| Wrong password and unknown account are indistinguishable | Telling them apart is a free validated-address list for credential stuffing |
| Sign-in is refused when the rate-limit store is unreachable | Fails closed on purpose. Chat fails open — the asymmetry is the decision |
| Conversation content is not field-level encrypted | The application must be able to decrypt it, so an application compromise defeats it. Volume encryption plus access control is the honest level ([10](docs/backend/10-security.md#encryption)) |
| Account lockout escalates rather than latching | A permanent lock hands an attacker a denial-of-service primitive against any address they know |

## Known gaps

Stated rather than discovered:

- **The eight provider adapters have never made a real API call.** They are
  covered by a shared contract suite against mocked HTTP. Live verification is
  the remaining gate before any adapter is production-supported.
- **BYOK keys are encrypted but not yet used.** The envelope encryption is
  implemented and tested; no endpoint accepts a user key, because shipping a
  "save your key" form whose keys nothing reads would be a fake feature.

## Handling

Fixes ship as a normal release with the advisory published at the same time. If
a deployment must act — rotating a key, changing a setting — that is stated in
the advisory rather than left to be inferred from a diff.
