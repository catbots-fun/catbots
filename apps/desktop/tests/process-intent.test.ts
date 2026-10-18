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

  it.each([
    { argv: ['Catbots', '--cli', 'uninstall'], purgeData: false },
    { argv: ['Catbots', '--cli', 'uninstall', '--purge-data'], purgeData: true },
  ])('parses the public uninstall command: $argv', ({ argv, purgeData }) => {
    expect(parseProcessIntent(argv, { packaged: true })).toEqual({
      kind: 'cli',
      command: { kind: 'uninstall', purgeData },
    });
  });

  it('defaults a packaged launch to open-ui', () => {
    expect(parseProcessIntent(['/Applications/Catbots.app/Contents/MacOS/Catbots'], {
      packaged: true,
    })).toEqual({ kind: 'open-ui' });
  });

  it('ignores Electron inspector flags when a packaged UI is launched by an automation host', () => {
    expect(parseProcessIntent([
      '/Applications/Catbots.app/Contents/MacOS/Catbots',
      '--inspect=0',
      '--remote-debugging-port=0',
    ], { packaged: true })).toEqual({ kind: 'open-ui' });
  });

  it('parses serve-web without opening a window', () => {
    expect(parseProcessIntent(['Catbots', '--serve-web'], { packaged: true })).toEqual({
      kind: 'serve-web',
      port: 5180,
      window: 'never',
    });
  });

  it('parses a packaged candidate maintenance operation', () => {
    expect(parseProcessIntent(['Catbots', '--serve-web', '--maintenance-operation', 'bootstrap-123'], { packaged: true })).toEqual({
      kind: 'serve-web', port: 5180, window: 'never', maintenanceOperationId: 'bootstrap-123',
    });
    expect(() => parseProcessIntent(['Catbots', '--serve-web', '--maintenance-operation', '../escape'], { packaged: true })).toThrow();
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
      argv: ['Catbots', '--control', 'prepare-maintenance', 'upgrade', 'operation-1', 'release-0.2.0'],
      command: {
        kind: 'prepare-maintenance',
        reason: 'upgrade',
        operationId: 'operation-1',
        targetRelease: 'release-0.2.0',
      },
    },
    {
      argv: ['Catbots', '--control', 'prepare-maintenance', 'uninstall', 'uninstall-1'],
      command: { kind: 'prepare-maintenance', reason: 'uninstall', operationId: 'uninstall-1' },
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
    ['Catbots', '--control', 'prepare-maintenance', 'uninstall'],
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
