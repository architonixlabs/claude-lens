#!/usr/bin/env node
// make-signing-cert.mjs — generate a self-signed Architonix Labs LLP code-signing
// certificate (PKCS#12 / .pfx) for INTERNAL distribution.
//
//   node scripts/make-signing-cert.mjs --password "choose-one"
//
// ⚠ READ THIS FIRST
// A self-signed certificate does NOT remove Windows SmartScreen or macOS
// Gatekeeper warnings for people outside your organisation. Those are driven by
// trust chains that terminate at a CA the OS already trusts (and, on Windows, by
// reputation). Self-signing is genuinely useful for exactly one thing: signing
// builds that your OWN machines will trust, once the certificate is installed
// into their trust stores (see the notes printed at the end, and SIGNING.md).
//
// For public distribution you need:
//   • Windows — an OV/EV code-signing certificate from a public CA. Since June
//     2023 the private key must live on FIPS 140-2 Level 2 hardware (USB token)
//     or a cloud HSM, so CI signing means a cloud signing service.
//   • macOS  — an Apple Developer Program membership ($99/yr), a Developer ID
//     Application certificate, and notarization. There is no free path.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'certs');

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split('=').slice(1).join('=');
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};

const ORG = arg('org', 'Architonix Labs LLP');
const COUNTRY = arg('country', 'IN');
const DAYS = Number(arg('days', 1095)); // 3 years
const PASSWORD = arg('password', '');

if (!PASSWORD) {
  console.error('Refusing to create an unprotected key.\n');
  console.error('Usage: node scripts/make-signing-cert.mjs --password "your-password"');
  console.error('       [--org "Architonix Labs LLP"] [--country IN] [--days 1095]');
  process.exit(1);
}

const sh = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();

try {
  sh('openssl', ['version']);
} catch {
  console.error('openssl was not found on PATH. Install OpenSSL (Git for Windows ships it) and retry.');
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const keyPath = path.join(OUT_DIR, 'architonix-code-signing.key');
const crtPath = path.join(OUT_DIR, 'architonix-code-signing.crt');
const pfxPath = path.join(OUT_DIR, 'architonix-code-signing.pfx');
const cfgPath = path.join(OUT_DIR, 'openssl.cnf');

// codeSigning EKU is what makes this usable by signtool / electron-builder.
fs.writeFileSync(cfgPath, `[req]
distinguished_name = dn
x509_extensions = v3
prompt = no

[dn]
CN = ${ORG}
O  = ${ORG}
C  = ${COUNTRY}

[v3]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
subjectKeyIdentifier = hash
`);

console.log(`generating a self-signed code-signing certificate for "${ORG}" (${DAYS} days)…\n`);

sh('openssl', ['req', '-x509', '-newkey', 'rsa:3072', '-sha256',
  '-keyout', keyPath, '-out', crtPath,
  '-days', String(DAYS), '-nodes', '-config', cfgPath]);

sh('openssl', ['pkcs12', '-export', '-out', pfxPath,
  '-inkey', keyPath, '-in', crtPath,
  '-name', ORG, '-passout', `pass:${PASSWORD}`]);

fs.rmSync(cfgPath, { force: true });

const fingerprint = sh('openssl', ['x509', '-in', crtPath, '-noout', '-fingerprint', '-sha256'])
  .trim().split('=').slice(1).join('=');

console.log('created:');
console.log(`  ${path.relative(process.cwd(), pfxPath)}   ← use this to sign (keep it secret)`);
console.log(`  ${path.relative(process.cwd(), crtPath)}   ← public cert, install this to trust builds`);
console.log(`  ${path.relative(process.cwd(), keyPath)}   ← private key (keep it secret)`);
console.log(`\nSHA-256 fingerprint:\n  ${fingerprint}`);

console.log(`
── To sign a build ─────────────────────────────────────────────────────────
  CSC_LINK=certs/architonix-code-signing.pfx CSC_KEY_PASSWORD='<password>' npm run dist:win

── To make YOUR machines trust it (internal distribution) ──────────────────
  Windows (elevated PowerShell), install into both stores:
    Import-Certificate -FilePath certs\\architonix-code-signing.crt \\
      -CertStoreLocation Cert:\\LocalMachine\\Root
    Import-Certificate -FilePath certs\\architonix-code-signing.crt \\
      -CertStoreLocation Cert:\\LocalMachine\\TrustedPublisher

  Verify a signed binary:
    Get-AuthenticodeSignature '.\\dist\\ClaudeLens Setup 1.0.0.exe' | Format-List

⚠ This does NOT silence SmartScreen or Gatekeeper for anyone who has not
  installed this certificate. See SIGNING.md for the real options.

⚠ certs/ is git-ignored. Never commit the .pfx or .key. For CI, store the .pfx
  base64-encoded as the CSC_LINK secret and the password as CSC_KEY_PASSWORD.
    base64 -w0 certs/architonix-code-signing.pfx > cert.b64
`);
