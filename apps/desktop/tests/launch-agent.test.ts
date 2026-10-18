import { describe, expect, it, vi } from 'vitest';
import {
  LaunchAgentController,
  renderLaunchAgent,
  type LaunchAgentCommandRunner,
} from '../src/main/service/launch-agent';

const template = `<?xml version="1.0" encoding="UTF-8"?>
<plist><dict>
<key>Label</key><string>__CATBOTS_LABEL__</string>
<key>ProgramArguments</key><array><string>__CATBOTS_EXECUTABLE__</string><string>--serve-web</string></array>
<key>StandardOutPath</key><string>__CATBOTS_STDOUT__</string>
<key>StandardErrorPath</key><string>__CATBOTS_STDERR__</string>
</dict></plist>`;

function fixture(printResults: Array<string | Error>) {
  const calls: Array<readonly [string, readonly string[]]> = [];
  const run: LaunchAgentCommandRunner = vi.fn(async (file, args) => {
    calls.push([file, args]);
    if (args[0] === 'print') {
      const result = printResults.shift();
      if (result instanceof Error) throw result;
      return { stdout: result ?? '' };
    }
    return { stdout: '' };
  });
  const writes: string[] = [];
  const controller = new LaunchAgentController({
    uid: 501,
    executablePath: '/Users/cat/Applications/Catbots.app/Contents/MacOS/Catbots',
    plistPath: '/Users/cat/Library/LaunchAgents/fun.catbots.web.plist',
    stdoutPath: '/Users/cat/Library/Logs/Catbots/service.log',
    stderrPath: '/Users/cat/Library/Logs/Catbots/service.error.log',
    template,
    run,
    verifyExecutable: async (path) => path,
    writeDefinition: async (_path, contents) => { writes.push(contents); },
  });
  return { calls, controller, writes };
}

describe('LaunchAgentController', () => {
  it('renders data as XML without shell interpolation', () => {
    const rendered = renderLaunchAgent(template, {
      label: 'fun.catbots.web',
      executablePath: '/Users/cat/A&B/$(touch nope)',
      stdoutPath: '/tmp/catbots.out',
      stderrPath: '/tmp/catbots.err',
    });

    expect(rendered).toContain('/Users/cat/A&amp;B/$(touch nope)');
    expect(rendered).not.toContain('/bin/sh');
  });

  it('bootstraps the graphical-user job with fixed launchctl arguments and verifies its program', async () => {
    const missing = Object.assign(new Error('not found'), { code: 113 });
    const expected = '/Users/cat/Applications/Catbots.app/Contents/MacOS/Catbots';
    const { calls, controller, writes } = fixture([missing, `program = ${expected}\n`]);

    await controller.start();

    expect(writes).toHaveLength(1);
    expect(calls).toEqual([
      ['/bin/launchctl', ['print', 'gui/501/fun.catbots.web']],
      ['/bin/launchctl', ['bootstrap', 'gui/501', '/Users/cat/Library/LaunchAgents/fun.catbots.web.plist']],
      ['/bin/launchctl', ['print', 'gui/501/fun.catbots.web']],
    ]);
  });

  it('unloads only a job whose executable matches the signed app path', async () => {
    const expected = '/Users/cat/Applications/Catbots.app/Contents/MacOS/Catbots';
    const missing = Object.assign(new Error('not found'), { code: 113 });
    const { calls, controller } = fixture([`program = ${expected}\n`, missing]);

    await controller.stop();

    expect(calls).toEqual([
      ['/bin/launchctl', ['print', 'gui/501/fun.catbots.web']],
      ['/bin/launchctl', ['bootout', 'gui/501/fun.catbots.web']],
      ['/bin/launchctl', ['print', 'gui/501/fun.catbots.web']],
    ]);
  });

  it('rejects a loaded job that points at another executable', async () => {
    const { controller, writes } = fixture(['program = /tmp/not-catbots\n']);

    await expect(controller.start()).rejects.toThrow('LAUNCH_AGENT_EXECUTABLE_MISMATCH');
    expect(writes).toEqual([]);
  });
});
