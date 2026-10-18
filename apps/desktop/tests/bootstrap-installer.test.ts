import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { access, chmod, cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import forgeConfig, { assertForgeReleaseTrust } from '../forge.config';
import { verifyProductionPackage } from '../../../scripts/verify-package-contents.mjs';

const repository = resolve(import.meta.dirname, '../../..');
const installer = join(repository, 'scripts/install.sh');
const temporaryDirectories: string[] = [];
const bootstrapKeys = generateKeyPairSync('rsa', { modulusLength: 3072 });
const packagedTrustPublicKey = bootstrapKeys.publicKey
  .export({ type: 'spki', format: 'pem' }).toString();
const packagedTrustMetadata = JSON.stringify({
  schemaVersion: 1, teamId: 'ABCDE12345', publicKey: packagedTrustPublicKey, commit: 'abc123',
  fingerprint: createHash('sha256').update(packagedTrustPublicKey).digest('hex'),
});

type Fixture = Awaited<ReturnType<typeof fixture>>;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(options: Readonly<{
  architecture?: string;
  manifestPatch?: Record<string, unknown>;
  artifactBytes?: Buffer;
  realCrypto?: boolean;
  rawManifest?: Buffer;
}> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'catbots-bootstrap-'));
  temporaryDirectories.push(root);
  const commands = join(root, 'commands');
  const home = join(root, 'home with spaces\nand newlines');
  const fixtures = join(root, 'fixtures');
  const log = join(root, 'commands.log');
  await Promise.all([mkdir(commands), mkdir(home), mkdir(fixtures)]);

  const keys = bootstrapKeys;
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const artifact = options.artifactBytes ?? Buffer.from('complete archive bytes');
  const sha256 = createHash('sha256').update(artifact).digest('hex');
  const architecture = options.architecture === 'x86_64' ? 'x64' : 'arm64';
  const manifest = {
    schemaVersion: 1,
    releaseId: '1.2.3+abc123',
    version: '1.2.3',
    commit: 'abc123',
    publishedAt: '2026-10-18T00:00:00.000Z',
    minimumMacOS: '13.0',
    bundleId: 'com.catbots.desktop',
    teamId: 'CATB0TTEAM',
    protocolVersion: 1,
    dataSchemaVersion: 7,
    artifacts: {
      arm64: {
        url: 'https://github.com/catbots-fun/catbots/releases/download/v1.2.3/Catbots-darwin-arm64.zip',
        sha256,
        bytes: artifact.byteLength,
      },
      x64: {
        url: 'https://github.com/catbots-fun/catbots/releases/download/v1.2.3/Catbots-darwin-x64.zip',
        sha256,
        bytes: artifact.byteLength,
      },
    },
    ...options.manifestPatch,
  };
  const manifestBytes = options.rawManifest ?? Buffer.from(JSON.stringify(manifest));
  await Promise.all([
    writeFile(join(fixtures, 'manifest.json'), manifestBytes),
    writeFile(join(fixtures, 'manifest.json.sig'), sign('sha256', manifestBytes, keys.privateKey)),
    writeFile(join(fixtures, 'Catbots.zip'), artifact),
  ]);

  await writeExecutable(join(commands, 'curl'), `#!/bin/sh
printf 'curl %s\\n' "$*" >> "$FAKE_LOG"
output=
write_out=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output=$2; shift 2 ;;
    --dump-header) headers=$2; shift 2 ;;
    --write-out) write_out=$2; shift 2 ;;
    --*) shift ;;
    *) url=$1; shift ;;
  esac
done
case "$url" in
  *manifest.json.sig) cp "$FIXTURES/manifest.json.sig" "$output" ;;
  *manifest.json) cp "$FIXTURES/manifest.json" "$output" ;;
  *) cp "$FIXTURES/Catbots.zip" "$output"
     if [ "\${FAKE_INTERRUPT_DOWNLOAD:-0}" != 0 ]; then
       printf partial > "$output"
       : > "$FAKE_INTERRUPT_READY"
       trap 'exit 129' HUP
       trap 'exit 130' INT
       trap 'exit 143' TERM
       while :; do sleep 1; done
     fi
     if [ -n "\${headers:-}" ]; then : > "$headers"; fi
     if [ -n "\${headers:-}" ] && [ -n "\${FAKE_REDIRECT_CHAIN:-}" ]; then printf '%b' "$FAKE_REDIRECT_CHAIN" > "$headers"; fi
     if [ "\${FAKE_PARTIAL_DOWNLOAD:-0}" != 0 ]; then printf partial > "$output"; exit 18; fi
     if [ -n "$write_out" ]; then printf '%s' "\${FAKE_FINAL_URL:-$url}"; fi ;;
esac
`);
  await writeExecutable(join(commands, 'openssl'), `#!/bin/sh
printf 'openssl %s\\n' "$*" >> "$FAKE_LOG"
[ "\${FAKE_BAD_SIGNATURE:-0}" = 0 ]
`);
  await writeExecutable(join(commands, 'osascript'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = args.at(-2);
const arch = args.at(-1);
if (args.length >= 8) {
  fs.writeFileSync(args.at(-5), '{"request":"fixture"}\\n', { mode: 0o600 });
  process.exit(0);
}
if (file.includes('installer-result')) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ready = value.health?.readiness === 'ready';
  const stopped = value.health?.product === 'catbots' && value.health?.bundleId === 'com.catbots.desktop'
    && value.health?.state === 'stopped' && Object.keys(value.health).length === 3;
  if (value.kind !== 'installed' || value.releaseId !== arch || (!ready && !stopped)) process.exit(65);
  process.stdout.write(stopped ? 'stopped' : 'ready');
  process.exit(0);
}
const m = JSON.parse(fs.readFileSync(file, 'utf8'));
const exact = (o, keys) => Object.keys(o).sort().join(',') === [...keys].sort().join(',');
if (!exact(m, ['schemaVersion','releaseId','version','commit','publishedAt','minimumMacOS','bundleId','teamId','protocolVersion','dataSchemaVersion','artifacts']) ||
    !exact(m.artifacts, ['arm64','x64']) || !exact(m.artifacts[arch], ['url','sha256','bytes'])) process.exit(65);
const a = m.artifacts[arch];
process.stdout.write([m.releaseId,m.version,m.minimumMacOS,m.bundleId,m.teamId,String(m.protocolVersion),String(m.dataSchemaVersion),a.url,a.sha256,String(a.bytes)].join('\\t'));
`);
  await writeExecutable(join(commands, 'uname'), `#!/bin/sh
[ "\${1:-}" = -m ] && printf '%s\\n' "${options.architecture ?? 'arm64'}" || printf 'Darwin\\n'
`);
  await writeExecutable(join(commands, 'sw_vers'), `#!/bin/sh
printf '%s\\n' "\${FAKE_MACOS_VERSION:-14.5}"
`);
  await writeExecutable(join(commands, 'unzip'), `#!/bin/sh
printf 'unzip %s\\n' "$*" >> "$FAKE_LOG"
if [ "\${1:-}" = -Z1 ]; then
  printf '%b' "\${FAKE_ZIP_ENTRIES:-Catbots.app/Contents/MacOS/Catbots\\nCatbots.app/Contents/Info.plist\\n}"
  exit 0
fi
destination=
while [ "$#" -gt 0 ]; do [ "$1" = -d ] && destination=$2; shift; done
mkdir -p "$destination/Catbots.app/Contents/MacOS"
cat > "$destination/Catbots.app/Contents/MacOS/Catbots" <<'APP'
#!/bin/sh
printf 'Catbots %s\\n' "$*" >> "$FAKE_LOG"
if [ "\${FAKE_INSTALLER_FAIL:-0}" != 0 ]; then exit 9; fi
if [ "\${FAKE_STOPPED_RESULT:-0}" != 0 ]; then
  printf '{"kind":"installed","operationId":"bootstrap-1","releaseId":"1.2.3+abc123","health":{"product":"catbots","bundleId":"com.catbots.desktop","state":"stopped"}}\\n'
  exit 0
fi
printf '{"kind":"installed","operationId":"bootstrap-1","releaseId":"1.2.3+abc123","health":{"product":"catbots","bundleId":"com.catbots.desktop","releaseId":"1.2.3+abc123","version":"1.2.3","commit":"abc123","architecture":"arm64","protocolVersion":1,"dataSchemaVersion":7,"instanceId":"instance-1","readiness":"ready","resumePolicy":"manual-only"}}\\n'
APP
chmod 755 "$destination/Catbots.app/Contents/MacOS/Catbots"
printf fixture > "$destination/Catbots.app/Contents/Info.plist"
if [ "\${FAKE_HARDLINK:-0}" != 0 ]; then ln "$destination/Catbots.app/Contents/Info.plist" "$destination/Catbots.app/Contents/Info-copy.plist"; fi
`);
  await writeExecutable(join(commands, 'zipinfo'), `#!/bin/sh
printf '%s\\n' "\${FAKE_ZIP_MODE:--rw-r--r--  3.0 unx 1 bx stor 26-Oct-18 00:00 Catbots.app/Contents/Info.plist}"
`);
  await writeExecutable(join(commands, 'codesign'), `#!/bin/sh
printf 'codesign %s\\n' "$*" >> "$FAKE_LOG"
[ "\${FAKE_CODESIGN_FAIL:-0}" = 0 ] || exit 1
case "$*" in *--display*)
  printf 'TeamIdentifier=%s\\n' "\${FAKE_TEAM_ID:-CATB0TTEAM}" >&2
  [ "\${FAKE_HARDENED_RUNTIME_FAIL:-0}" != 0 ] || printf 'flags=0x10000(runtime)\\n' >&2
  ;;
esac
`);
  await writeExecutable(join(commands, 'plutil'), `#!/bin/sh
case "$*" in *CFBundleIdentifier*) printf '%s\\n' "\${FAKE_BUNDLE_ID:-com.catbots.desktop}" ;; *CFBundleShortVersionString*) printf '1.2.3\\n' ;; esac
`);
  for (const [name, body] of Object.entries({
    spctl: '#!/bin/sh\n[ "${FAKE_GATEKEEPER_FAIL:-0}" = 0 ]\n',
    stapler: '#!/bin/sh\n[ "${FAKE_STAPLE_FAIL:-0}" = 0 ]\n',
    lipo: '#!/bin/sh\nprintf "%s\\n" "${FAKE_LIPO_ARCHS:-arm64 x86_64}"\n',
  })) await writeExecutable(join(commands, name), body);

  const script = join(root, 'install.sh');
  let source = await readFile(installer, 'utf8');
  const replacements: Record<string, string> = {
    CURL: join(commands, 'curl'), OPENSSL: join(commands, 'openssl'), OSASCRIPT: join(commands, 'osascript'),
    UNAME: join(commands, 'uname'), SW_VERS: join(commands, 'sw_vers'), UNZIP: join(commands, 'unzip'),
    ZIPINFO: join(commands, 'zipinfo'), CODESIGN: join(commands, 'codesign'), PLUTIL: join(commands, 'plutil'),
    SPCTL: join(commands, 'spctl'), STAPLER: join(commands, 'stapler'), LIPO: join(commands, 'lipo'),
  };
  for (const [name, path] of Object.entries(replacements)) {
    if (name === 'OPENSSL' && options.realCrypto) continue;
    source = source.replace(new RegExp(`^${name}=.*$`, 'm'), `${name}='${path}'`);
  }
  source = source.replace(/^PUBLIC_KEY_PEM='[^']*'$/m, `PUBLIC_KEY_PEM='${publicKey.trim()}\n'`);
  source = source.replace("PUBLIC_KEY_FINGERPRINT='CATBOTS_RELEASE_TRUST_FINGERPRINT_REQUIRED'",
    `PUBLIC_KEY_FINGERPRINT='${createHash('sha256').update(publicKey).digest('hex')}'`);
  source = source.replace("TEAM_ID='CATBOTS_TEAM_ID_REQUIRED'", "TEAM_ID='CATB0TTEAM'");
  source = source.replace("RELEASE_TRUST_STATE='CATBOTS_RELEASE_TRUST_NOT_INJECTED'", "RELEASE_TRUST_STATE='CATBOTS_RELEASE_TRUST_INJECTED'");
  await writeFile(script, source, { mode: 0o700 });
  return { root, script, home, fixtures, log, commands };
}

async function run(f: Fixture, args: string[] = [], environment: Record<string, string> = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveRun) => {
    const child = spawn('/bin/sh', [f.script, ...args], {
      env: { ...process.env, HOME: f.home, TMPDIR: f.root, FAKE_LOG: f.log, FIXTURES: f.fixtures, ...environment },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (value) => { stdout += value; });
    child.stderr.on('data', (value) => { stderr += value; });
    child.on('close', (code) => resolveRun({ code, stdout, stderr }));
  });
}

async function writeExecutable(path: string, value: string) {
  await writeFile(path, value);
  await chmod(path, 0o700);
}

describe('signed macOS bootstrap installer', () => {
  it('fails closed in the direct Forge packaging hook before sentinel artifacts are produced', async () => {
    await expect(assertForgeReleaseTrust(undefined, undefined)).rejects.toThrow('Production packaging requires');
  });

  it('packages the reviewed bootstrap and requires it at the release boundary', async () => {
    const resources = (forgeConfig.packagerConfig as { extraResource?: string[] }).extraResource;
    expect(resources).toContain('../../scripts/install.sh');
    const packageRoot = await mkdtemp(join(tmpdir(), 'catbots-bootstrap-package-'));
    temporaryDirectories.push(packageRoot);
    for (const entry of [
      'Catbots.app/Contents/Resources/app/.vite/renderer/main_window/web.html',
      'Catbots.app/Contents/Resources/catbots',
      'Catbots.app/Contents/Resources/fun.catbots.web.plist.template',
    ]) {
      const path = join(packageRoot, entry);
      await mkdir(resolve(path, '..'), { recursive: true });
      await writeFile(path, 'fixture');
    }
    await expect(verifyProductionPackage(packageRoot)).rejects.toThrow('Resources/install.sh');
  });

  it('rejects distribution packages that still contain release trust sentinels', async () => {
    const packageRoot = await mkdtemp(join(tmpdir(), 'catbots-bootstrap-sentinel-'));
    temporaryDirectories.push(packageRoot);
    for (const [entry, contents] of [
      ['Catbots.app/Contents/Resources/app/.vite/renderer/main_window/web.html', 'fixture'],
      ['Catbots.app/Contents/Resources/catbots', 'fixture'],
      ['Catbots.app/Contents/Resources/fun.catbots.web.plist.template', 'fixture'],
      ['Catbots.app/Contents/Resources/install.sh', "TEAM_ID='CATBOTS_TEAM_ID_REQUIRED'"],
      ['Catbots.app/Contents/Resources/release-trust.json', packagedTrustMetadata],
    ]) {
      const path = join(packageRoot, entry);
      await mkdir(resolve(path, '..'), { recursive: true });
      await writeFile(path, contents);
    }
    await expect(verifyProductionPackage(packageRoot)).rejects.toThrow('Release trust sentinel');
  });

  it('downloads with constrained TLS, verifies trust, maps arm64, and invokes reconcile from a private cleaned directory', async () => {
    const f = await fixture();
    const result = await run(f);
    expect(result, result.stderr).toMatchObject({ code: 0 });
    expect(result.stdout).toContain('Catbots 1.2.3 is healthy');
    const log = await readFile(f.log, 'utf8');
    expect(log).toContain("curl --proto =https --proto-redir =https --tlsv1.2 --fail --silent --show-error --location --max-redirs 5");
    expect(log).toContain('Catbots --installer reconcile');
    expect(log).toContain('codesign --verify --deep --strict');
    expect((await readFile(join(f.fixtures, 'manifest.json'))).byteLength).toBeGreaterThan(0);
    await expect((await import('node:fs/promises')).readdir(f.root)).resolves.not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^catbots-install\./)]),
    );
  });

  it('maps x86_64 to the x64 immutable release asset and honors an exact requested version', async () => {
    const f = await fixture({ architecture: 'x86_64' });
    const result = await run(f, ['--version', '1.2.3']);
    expect(result.code, result.stderr).toBe(0);
    expect(await readFile(f.log, 'utf8')).toContain('Catbots-darwin-x64.zip');
    expect((await run(f, ['--version', '1.2.4'])).code).not.toBe(0);
  });

  it('accepts and reports the explicit stopped-service install result contract', async () => {
    const f = await fixture();
    const result = await run(f, [], { FAKE_STOPPED_RESULT: '1' });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('Catbots 1.2.3 is installed and intentionally stopped.');
  });

  it.each([
    ['signature', { FAKE_BAD_SIGNATURE: '1' }],
    ['redirect host', { FAKE_FINAL_URL: 'https://attacker.invalid/Catbots.zip' }],
    ['code signature', { FAKE_CODESIGN_FAIL: '1' }],
    ['hardened runtime', { FAKE_HARDENED_RUNTIME_FAIL: '1' }],
    ['team identity', { FAKE_TEAM_ID: 'EVILTEAM' }],
    ['Gatekeeper', { FAKE_GATEKEEPER_FAIL: '1' }],
    ['notarization staple', { FAKE_STAPLE_FAIL: '1' }],
    ['supported macOS', { FAKE_MACOS_VERSION: '12.6' }],
    ['installer health command', { FAKE_INSTALLER_FAIL: '1' }],
  ])('fails closed when %s verification fails', async (_name, environment) => {
    const f = await fixture();
    const sentinel = join(f.home, 'Applications/Catbots.app/current-sentinel');
    await mkdir(resolve(sentinel, '..'), { recursive: true });
    await writeFile(sentinel, 'preserve-current');
    expect((await run(f, [], environment as Record<string, string>)).code).not.toBe(0);
    expect(await readFile(sentinel, 'utf8')).toBe('preserve-current');
  });

  it('rejects invalid JSON and strict-schema extensions after signature verification', async () => {
    const f = await fixture({ manifestPatch: { untrusted: true } });
    expect((await run(f)).code).not.toBe(0);
    expect(await readFile(f.log, 'utf8')).toContain('openssl dgst -sha256 -verify');
  });

  it('rejects truly malformed signed JSON before artifact download', async () => {
    const f = await fixture({ rawManifest: Buffer.from('{"schemaVersion":1') });
    expect((await run(f)).code).not.toBe(0);
    expect(await readFile(f.log, 'utf8')).not.toContain('Catbots-darwin');
  });

  it('verifies a real detached RSA signature over the exact manifest bytes', async () => {
    const f = await fixture({ realCrypto: true });
    expect((await run(f)).code).toBe(0);
  });

  it('rejects a malicious intermediate redirect even when the final URL is approved', async () => {
    const f = await fixture();
    const result = await run(f, [], {
      FAKE_REDIRECT_CHAIN: 'HTTP/1.1 302 Found\\r\\nLocation: https://attacker.invalid/steal\\r\\n\\r\\nHTTP/1.1 302 Found\\r\\nLocation: https://release-assets.githubusercontent.com/Catbots.zip\\r\\n\\r\\n',
      FAKE_FINAL_URL: 'https://release-assets.githubusercontent.com/Catbots.zip',
    });
    expect(result.code).not.toBe(0);
  });

  it.each([
    { name: 'partial download', environment: { FAKE_PARTIAL_DOWNLOAD: '1' } },
    { name: 'unsupported architecture', environment: {}, architecture: 'powerpc' },
    { name: 'bundle identifier', environment: { FAKE_BUNDLE_ID: 'evil.bundle' } },
    { name: 'symlink entry', environment: { FAKE_ZIP_MODE: 'lrwxr-xr-x  3.0 unx 1 bx stor 26-Oct-18 00:00 Catbots.app/escape' } },
    { name: 'hardlink entry', environment: { FAKE_HARDLINK: '1' } },
  ])('rejects hostile $name input before installer mutation', async ({ environment, architecture }) => {
    const f = await fixture({ architecture });
    const sentinel = join(f.home, 'Applications/Catbots.app/current-sentinel');
    await mkdir(resolve(sentinel, '..'), { recursive: true });
    await writeFile(sentinel, 'preserve-current');
    expect((await run(f, [], environment as Record<string, string>)).code).not.toBe(0);
    expect(await readFile(sentinel, 'utf8')).toBe('preserve-current');
    expect(await readFile(f.log, 'utf8')).not.toContain('Catbots --installer');
  });

  it.each([
    { signal: 'SIGHUP' as const, exitCode: 129 },
    { signal: 'SIGINT' as const, exitCode: 130 },
    { signal: 'SIGTERM' as const, exitCode: 143 },
  ])('cleans the private download directory, exits $exitCode, and preserves the current app after $signal', async ({ signal, exitCode }) => {
    const f = await fixture();
    const sentinel = join(f.home, 'Applications/Catbots.app/current-sentinel');
    const ready = join(f.root, `interrupt-${signal}`);
    await mkdir(resolve(sentinel, '..'), { recursive: true });
    await writeFile(sentinel, 'preserve-current');
    const child = spawn('/bin/sh', [f.script], {
      detached: true,
      env: {
        ...process.env, HOME: f.home, TMPDIR: f.root, FAKE_LOG: f.log, FIXTURES: f.fixtures,
        FAKE_INTERRUPT_DOWNLOAD: '1', FAKE_INTERRUPT_READY: ready,
      },
      stdio: 'ignore',
    });
    await waitForPath(ready);
    process.kill(-child.pid!, signal);
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
      child.once('close', (code, observedSignal) => resolveExit({ code, signal: observedSignal }));
    });

    expect(exit).toEqual({ code: exitCode, signal: null });
    expect(await readFile(sentinel, 'utf8')).toBe('preserve-current');
    expect(await readdir(f.root)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^catbots-install\./)]));
  });

  it.each([
    ['/absolute/Catbots.app', 'absolute archive path'],
    ['Catbots.app/../escape', 'archive traversal'],
    ['Catbots.app/Contents/evil\n../escape', 'newline archive path'],
  ])('rejects %s without invoking the signed installer (%s)', async (entry) => {
    const f = await fixture();
    const result = await run(f, [], { FAKE_ZIP_ENTRIES: `${entry}\n` });
    expect(result.code).not.toBe(0);
    expect(await readFile(f.log, 'utf8')).not.toContain('Catbots --installer');
  });

  it('rejects artifact size and digest mismatches before extraction', async () => {
    const f = await fixture({ manifestPatch: {
      artifacts: {
        arm64: { url: 'https://github.com/catbots-fun/catbots/releases/download/v1.2.3/Catbots-darwin-arm64.zip', sha256: '0'.repeat(64), bytes: 1 },
        x64: { url: 'https://github.com/catbots-fun/catbots/releases/download/v1.2.3/Catbots-darwin-x64.zip', sha256: '0'.repeat(64), bytes: 1 },
      },
    } });
    expect((await run(f)).code).not.toBe(0);
    expect(await readFile(f.log, 'utf8')).not.toContain('unzip -q');
  });

  it('routes uninstall and explicit purge through the currently installed signed app', async () => {
    const f = await fixture();
    const executable = join(f.home, 'Applications/Catbots.app/Contents/MacOS/Catbots');
    await mkdir(resolve(executable, '..'), { recursive: true });
    await cp(join(f.commands, 'codesign'), executable);
    await chmod(executable, 0o700);
    expect((await run(f, ['--uninstall'])).code).toBe(0);
    expect((await run(f, ['--uninstall', '--purge-data'])).code).toBe(0);
    const log = await readFile(f.log, 'utf8');
    expect(log).toContain('codesign --verify --deep --strict');
  });
});

async function waitForPath(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { await access(path); return; } catch { await new Promise((resolveDelay) => setTimeout(resolveDelay, 25)); }
  }
  throw new Error(`Timed out waiting for ${path}`);
}
