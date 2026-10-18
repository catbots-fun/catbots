import { describe, expect, it } from 'vitest';
import {
  ProcessIntentParseError,
  parseProcessIntent,
} from '../src/main/application/process-intent';

describe('parseProcessIntent', () => {
  it.each(['open', 'status', 'start', 'stop'] as const)('parses the public %s service command', (command) => {
    expect(parseProcessIntent(['Catbots', '--cli', command], { packaged: true })).toEqual({
      kind: 'cli',
      command,
    });
  });

  it('defaults a packaged launch to open-ui', () => {
    expect(parseProcessIntent(['/Applications/Catbots.app/Contents/MacOS/Catbots'], {
      packaged: true,
    })).toEqual({ kind: 'open-ui' });
  });

  it('parses serve-web without opening a window', () => {
    expect(parseProcessIntent(['Catbots', '--serve-web'], { packaged: true })).toEqual({
      kind: 'serve-web',
      port: 5180,
      window: 'never',
    });
  });

  it.each([
    {
      argv: ['Catbots', '--control', 'status'],
      command: { kind: 'status' },
    },
    {
      argv: ['Catbots', '--control', 'mint-browser-ticket'],
      command: { kind: 'mint-browser-ticket' },
    },
    {
      argv: ['Catbots', '--control', 'prepare-maintenance', 'upgrade', 'release-0.2.0'],
      command: {
        kind: 'prepare-maintenance',
        reason: 'upgrade',
        targetRelease: 'release-0.2.0',
      },
    },
    {
      argv: ['Catbots', '--control', 'prepare-maintenance', 'uninstall'],
      command: { kind: 'prepare-maintenance', reason: 'uninstall' },
    },
    {
      argv: ['Catbots', '--control', 'shutdown', 'lease-123'],
      command: { kind: 'shutdown', leaseId: 'lease-123' },
    },
  ])('parses control commands: $argv', ({ argv, command }) => {
    expect(parseProcessIntent(argv, { packaged: true })).toEqual({
      kind: 'control',
      command,
    });
  });

  it('parses installer reconcile', () => {
    expect(parseProcessIntent([
      'Catbots',
      '--installer',
      'reconcile',
      '/private/tmp/catbots-install/request.json',
    ], { packaged: true })).toEqual({
      kind: 'installer',
      command: {
        kind: 'reconcile',
        requestFile: '/private/tmp/catbots-install/request.json',
      },
    });
  });

  it('rejects installer mode from an unpackaged development process', () => {
    expect(() => parseProcessIntent([
      'electron',
      '--installer',
      'reconcile',
      '/private/tmp/catbots-install/request.json',
    ], { packaged: false })).toThrow(ProcessIntentParseError);
  });

  it.each([
    ['Catbots', '--unknown'],
    ['Catbots', '--serve-web', '--control', 'status'],
    ['Catbots', '--control'],
    ['Catbots', '--control', 'prepare-maintenance', 'upgrade'],
    ['Catbots', '--control', 'prepare-maintenance', 'uninstall', 'unexpected-release'],
    ['Catbots', '--cli'],
    ['Catbots', '--cli', 'update'],
    ['Catbots', '--cli', 'start', 'unexpected'],
    ['Catbots', '--control', 'shutdown'],
    ['Catbots', '--installer', 'reconcile'],
    ['Catbots', '--installer', 'uninstall', '--purge-data', '--extra'],
  ])('rejects unknown or conflicting arguments: %j', (...argv) => {
    expect(() => parseProcessIntent(argv, { packaged: true })).toThrow(ProcessIntentParseError);
  });
});
