# Code signing & release builds

What it costs to make ClaudeLens installers run without scary warnings, and how to build
for every platform.

---

## The short version

| Goal | What it needs | Cost |
|------|---------------|------|
| Sign builds your **own machines** trust | Self-signed cert (`npm run make-cert`) + install it into their trust stores | free |
| No **Windows SmartScreen** warning for anyone | OV/EV code-signing cert from a public CA, key on hardware/cloud HSM | ~$200–600/yr |
| No **macOS Gatekeeper** warning for anyone | Apple Developer Program + Developer ID cert + notarization | $99/yr |

**A self-signed certificate does not remove SmartScreen or Gatekeeper warnings for anyone
who hasn't installed it.** This is not a configuration problem — those systems trust chains
that end at a CA the OS already ships, and Windows additionally weighs publisher reputation.
There is no free workaround. Demonstrated:

```text
$ Get-AuthenticodeSignature 'dist\ClaudeLens Setup 1.0.0.exe'
Status    : UnknownError
StatusMsg : A certificate chain processed, but terminated in a root certificate
            which is not trusted by the trust provider
Signer    : C=IN, O=Architonix Labs LLP, CN=Architonix Labs LLP
```

The binary is genuinely signed as Architonix Labs LLP — Windows just doesn't trust that root.

---

## Can Let's Encrypt issue the certificate? No.

Let's Encrypt issues **TLS server certificates**, which are a different kind of certificate
from a **code-signing** one. This isn't a configuration hurdle — the two are incompatible by
design:

| | Let's Encrypt | Code signing |
|---|---|---|
| Extended Key Usage | `serverAuth` / `clientAuth` | `codeSigning` (1.3.6.1.5.5.7.3.3) |
| Validation | Domain Validated — proves you control a hostname | OV/EV — proves the **legal entity** exists |
| Trust programme | Browser/OS **TLS** root stores | Microsoft Trusted Root **code-signing** programme (separate) |
| Key storage | Software keys, fully automated | FIPS 140-2 L2 hardware or cloud HSM, mandated |
| Lifetime | 90 days, auto-renewed | 1–3 years |

Authenticode checks the `codeSigning` EKU and rejects a certificate without it, so a Let's
Encrypt certificate cannot sign a Windows binary even though ISRG Root X1 is trusted for TLS.
Domain validation also can't back an "Architonix Labs LLP" identity claim — that's precisely
what OV/EV validation is for. Let's Encrypt has said they have no plans to issue code-signing
certificates, and the hardware-key requirement is fundamentally at odds with their automated
model.

**No free CA issues code-signing certificates.** Signing that the public trusts costs money.

**Where Let's Encrypt *is* the right tool here:** if you ever host the Docker viewer on a
domain, use Let's Encrypt for its HTTPS certificate (via Caddy, or nginx/Traefik + certbot).
That's the TLS item in the roadmap and it is genuinely free — it's just a different problem
from signing the installers.

---

## Self-signed (internal distribution)

Right choice when the installer only ever runs on Architonix machines you control.

```bash
node scripts/make-signing-cert.mjs --password "pick-a-strong-one"
```

Writes to `certs/` (git-ignored):

- `architonix-code-signing.pfx` — signing material, **secret**
- `architonix-code-signing.crt` — public certificate, distribute this to trust the builds
- `architonix-code-signing.key` — private key, **secret**

Build signed:

```bash
CSC_LINK=certs/architonix-code-signing.pfx CSC_KEY_PASSWORD='…' npm run dist:win
```

Trust it on a target machine (elevated PowerShell) — both stores are required, `Root` to
trust the chain and `TrustedPublisher` to stop the prompt:

```powershell
Import-Certificate -FilePath architonix-code-signing.crt -CertStoreLocation Cert:\LocalMachine\Root
Import-Certificate -FilePath architonix-code-signing.crt -CertStoreLocation Cert:\LocalMachine\TrustedPublisher
```

Across a fleet, push the `.crt` via Group Policy (*Computer Configuration → Windows Settings →
Security Settings → Public Key Policies*) rather than doing it by hand.

> Installing a root certificate means that key can vouch for **any** software on that machine.
> Treat the `.pfx` like a production credential: strong password, restricted access, and
> rotate it if it ever leaks.

---

## Public distribution

### Windows

Buy an **OV** (organisation validated) or **EV** (extended validation) code-signing
certificate — Sectigo, DigiCert, GlobalSign. Requires proving Architonix Labs LLP is a real
registered entity (registry records, verifiable phone listing, sometimes a D-U-N-S number).

- **OV** is cheaper; SmartScreen reputation still builds up over downloads, so early users
  may see a warning for a while.
- **EV** gets immediate SmartScreen reputation and costs more.

Since **June 2023** the CA/Browser Forum requires code-signing private keys to live on
FIPS 140-2 Level 2 hardware. Practically: a USB token (can't be used by cloud CI) or a cloud
signing service — **DigiCert KeyLocker**, **Azure Trusted Signing**, **SSL.com eSigner**. For
CI you want the cloud option. Azure Trusted Signing is currently the cheapest route if the
entity qualifies.

### macOS

1. Join the **Apple Developer Program** ($99/yr).
2. Create a **Developer ID Application** certificate.
3. Sign, then **notarize** — Apple scans the build and issues a ticket that gets stapled to it.

`electron-builder` notarizes automatically when these are set:

```bash
APPLE_ID=you@architonixlabs.com
APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx   # appleid.apple.com → App-Specific Passwords
APPLE_TEAM_ID=XXXXXXXXXX
CSC_LINK=…/developer-id.p12
CSC_KEY_PASSWORD=…
```

There is no free alternative. Unsigned macOS apps can still be opened via
*System Settings → Privacy & Security → Open Anyway*, which is acceptable internally but not
for public distribution.

### Wiring certificates into CI

`.github/workflows/release.yml` already reads these secrets and builds **unsigned** when they
are absent — so nothing breaks before you buy certificates.

```bash
base64 -w0 certs/architonix-code-signing.pfx > cert.b64   # macOS: base64 -i … -o …
gh secret set CSC_LINK          < cert.b64
gh secret set CSC_KEY_PASSWORD  --body 'your-password'
# macOS notarization
gh secret set APPLE_ID --body '…'
gh secret set APPLE_APP_SPECIFIC_PASSWORD --body '…'
gh secret set APPLE_TEAM_ID --body '…'
```

Then delete `cert.b64`.

---

## Building for each platform

**Every OS must be built on that OS.** A macOS `.dmg` cannot be produced from Windows or
Linux (it needs Apple tooling), and Windows NSIS installers need Windows tooling.

### GitHub Actions (recommended — covers all three)

`.github/workflows/release.yml` builds Windows, macOS and Linux in parallel on GitHub-hosted
runners and attaches the artifacts to the release. Trigger it by pushing a `v*` tag, or
manually with an existing tag:

```bash
gh workflow run release.yml -f tag=v1.0.0
```

**Cost.** This repo is private, so runner minutes bill against the monthly allowance with
multipliers: **Linux 1x, Windows 2x, macOS 10x**. GitHub Free includes 2,000 minutes/month,
so a full three-platform release costs roughly 60–80 "minutes" of that budget — comfortably
within it for regular releases. Making the repo **public** makes all of it free and unlimited.

### Linux on the LAN box over SSH

Perfectly workable, and the deploy host (`<build-host>`) is reachable — but it's the *harder*
path now that CI covers Linux for free. Use it when you want a build without touching CI:

```bash
ssh <user>@<build-host> '
  git clone https://github.com/architonixlabs/claude-lens && cd claude-lens &&
  npm ci && npm run dist:linux'
scp <user>@<build-host>:claude-lens/dist/*.AppImage .
```

The host needs Node 20+. AppImage builds also want `libarchive-tools`/`fakeroot`; alternatively
run the build in the official container and keep the host clean:

```bash
docker run --rm -v "$PWD":/project electronuserland/builder:wine \
  /bin/bash -c "npm ci && npm run dist:linux"
```

> SSH from this workstation currently fails with `Permission denied (publickey)` for user
> `Ram` — the key at `~/.ssh/id_ed25519.pub` isn't authorised there yet. Fix with
> `ssh-copy-id <user>@<build-host>` using the correct account.

### Free macOS build options

| Option | Free tier | Notes |
|--------|-----------|-------|
| **GitHub Actions** | 2,000 min/mo (macOS ×10); unlimited if the repo is public | Already wired up — the simplest answer |
| **Codemagic** | 500 min/mo on macOS M-series | Generous free tier, genuinely free for private repos |
| **Cirrus CI** | Free for public repos only | Fast macOS VMs |
| **Xcode Cloud** | 25 compute-hours/mo | Requires the paid Apple Developer account anyway |

Paid/dedicated (only if you need a persistent machine): MacStadium, Scaleway Mac mini,
AWS EC2 Mac (24-hour minimum allocation).

**Recommendation:** use GitHub Actions. It already exists in this repo, needs no new accounts,
and covers all three platforms. Reach for Codemagic only if macOS minutes become a constraint
and you don't want to make the repo public.
