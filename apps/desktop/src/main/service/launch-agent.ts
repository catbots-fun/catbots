import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

export const launchAgentLabel = 'fun.catbots.web';

export type LaunchAgentCommandRunner = (
  file: string,
  args: readonly string[],
) => Promise<Readonly<{ stdout: string; stderr?: string }>>;

export type LaunchAgentStatus = Readonly<{
  loaded: boolean;
  executablePath?: string;
}>;

type LaunchAgentDefinition = Readonly<{
  label: string;
  executablePath: string;
  stdoutPath: string;
  stderrPath: string;
}>;

type LaunchAgentOptions = LaunchAgentDefinition & Readonly<{
  uid: number;
  plistPath: string;
  template: string;
  run?: LaunchAgentCommandRunner;
  verifyExecutable?: (path: string) => Promise<string>;
  writeDefinition?: (path: string, contents: string) => Promise<void>;
}>;

const execute = promisify(execFile);

export class LaunchAgentController {
  private readonly run: LaunchAgentCommandRunner;
  private readonly verifyExecutable: (path: string) => Promise<string>;
  private readonly writeDefinition: (path: string, contents: string) => Promise<void>;

  constructor(private readonly options: Omit<LaunchAgentOptions, 'label'> & { label?: string }) {
    this.run = options.run ?? (async (file, args) => execute(file, [...args]));
    this.verifyExecutable = options.verifyExecutable ?? verifyExecutable;
    this.writeDefinition = options.writeDefinition ?? writeFileAtomically;
  }

  async status(): Promise<LaunchAgentStatus> {
    const target = this.jobTarget();
    try {
      const result = await this.run('/bin/launchctl', ['print', target]);
      const executablePath = parseProgramPath(result.stdout);
      if (executablePath === undefined) throw new Error('LAUNCH_AGENT_PROGRAM_MISSING');
      return { loaded: true, executablePath };
    } catch (error) {
      if (isMissingJob(error)) return { loaded: false };
      throw error;
    }
  }

  async start(): Promise<void> {
    const executablePath = await this.verifyExecutable(this.options.executablePath);
    if (executablePath !== this.options.executablePath) throw new Error('LAUNCH_AGENT_EXECUTABLE_MISMATCH');
    const before = await this.status();
    if (before.loaded) this.assertExpectedExecutable(before);
    await this.writeDefinition(this.options.plistPath, renderLaunchAgent(this.options.template, {
      label: this.label(),
      executablePath,
      stdoutPath: this.options.stdoutPath,
      stderrPath: this.options.stderrPath,
    }));

    if (before.loaded) {
      await this.run('/bin/launchctl', ['kickstart', '-k', this.jobTarget()]);
    } else {
      await this.run('/bin/launchctl', ['bootstrap', this.domainTarget(), this.options.plistPath]);
    }
    this.assertExpectedExecutable(await this.status());
  }

  async stop(): Promise<void> {
    const before = await this.status();
    if (!before.loaded) return;
    this.assertExpectedExecutable(before);
    await this.run('/bin/launchctl', ['bootout', this.jobTarget()]);
    if ((await this.status()).loaded) throw new Error('LAUNCH_AGENT_STILL_LOADED');
  }

  private assertExpectedExecutable(status: LaunchAgentStatus): void {
    if (!status.loaded || status.executablePath !== this.options.executablePath) {
      throw new Error('LAUNCH_AGENT_EXECUTABLE_MISMATCH');
    }
  }

  private label(): string {
    return this.options.label ?? launchAgentLabel;
  }

  private domainTarget(): string {
    return `gui/${this.options.uid}`;
  }

  private jobTarget(): string {
    return `${this.domainTarget()}/${this.label()}`;
  }
}

export function renderLaunchAgent(template: string, definition: LaunchAgentDefinition): string {
  const replacements: Readonly<Record<string, string>> = {
    __CATBOTS_LABEL__: definition.label,
    __CATBOTS_EXECUTABLE__: definition.executablePath,
    __CATBOTS_STDOUT__: definition.stdoutPath,
    __CATBOTS_STDERR__: definition.stderrPath,
  };
  let rendered = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    rendered = rendered.replaceAll(placeholder, escapeXml(value));
  }
  if (/__CATBOTS_[A-Z_]+__/.test(rendered)) throw new Error('LAUNCH_AGENT_TEMPLATE_INVALID');
  return rendered;
}

export async function loadLaunchAgentTemplate(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

async function verifyExecutable(path: string): Promise<string> {
  if (!path.startsWith('/')) throw new Error('LAUNCH_AGENT_EXECUTABLE_INVALID');
  await access(path, constants.X_OK);
  return realpath(path);
}

async function writeFileAtomically(path: string, contents: string): Promise<void> {
  const parent = dirname(path);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(parent, { recursive: true, mode: 0o700 });
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    const directory = await open(parent, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

function parseProgramPath(output: string): string | undefined {
  return /^\s*program\s*=\s*(.+?)\s*$/m.exec(output)?.[1];
}

function isMissingJob(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code: unknown = 'code' in error ? (error as { code?: unknown }).code : undefined;
  return code === '113' || code === 113 || /could not find service|not found/i.test(error.message);
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
