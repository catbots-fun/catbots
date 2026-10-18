export type ControlCommand =
  | { readonly kind: 'status' }
  | { readonly kind: 'mint-browser-ticket' }
  | {
      readonly kind: 'prepare-maintenance';
      readonly reason: 'upgrade';
      readonly targetRelease: string;
    }
  | {
      readonly kind: 'prepare-maintenance';
      readonly reason: 'uninstall';
    }
  | { readonly kind: 'shutdown'; readonly leaseId: string };

export type InstallerCommand =
  | { readonly kind: 'reconcile'; readonly requestFile: string }
  | { readonly kind: 'uninstall'; readonly purgeData: boolean };

export type ProcessIntent =
  | { readonly kind: 'serve-web'; readonly window: 'never'; readonly port: 5180 }
  | { readonly kind: 'open-ui' }
  | { readonly kind: 'control'; readonly command: ControlCommand }
  | { readonly kind: 'installer'; readonly command: InstallerCommand };

export class ProcessIntentParseError extends Error {
  readonly code = 'INVALID_PROCESS_INTENT';

  constructor() {
    super('Catbots received invalid process arguments.');
    this.name = 'ProcessIntentParseError';
  }
}

type ProcessIntentContext = Readonly<{
  packaged: boolean;
}>;

const invalid = (): never => {
  throw new ProcessIntentParseError();
};

export function parseProcessIntent(
  argv: readonly string[],
  context: ProcessIntentContext,
): ProcessIntent {
  if (argv.length === 0 || argv[0].length === 0) return invalid();

  const args = argv.slice(1);
  if (args.length === 0 || (args.length === 1 && args[0] === '--open-ui')) {
    return { kind: 'open-ui' };
  }

  if (args.length === 1 && args[0] === '--serve-web') {
    return { kind: 'serve-web', window: 'never', port: 5180 };
  }

  if (args[0] === '--control') {
    return {
      kind: 'control',
      command: parseControlCommand(args.slice(1)),
    };
  }

  if (args[0] === '--installer') {
    if (!context.packaged) return invalid();
    return {
      kind: 'installer',
      command: parseInstallerCommand(args.slice(1)),
    };
  }

  return invalid();
}

function parseControlCommand(args: readonly string[]): ControlCommand {
  if (args.length === 1 && args[0] === 'status') return { kind: 'status' };
  if (args.length === 1 && args[0] === 'mint-browser-ticket') {
    return { kind: 'mint-browser-ticket' };
  }
  if (args.length === 3 && args[0] === 'prepare-maintenance' && args[1] === 'upgrade') {
    if (args[2].length === 0) return invalid();
    return {
      kind: 'prepare-maintenance',
      reason: 'upgrade',
      targetRelease: args[2],
    };
  }
  if (args.length === 2 && args[0] === 'prepare-maintenance' && args[1] === 'uninstall') {
    return { kind: 'prepare-maintenance', reason: 'uninstall' };
  }
  if (args.length === 2 && args[0] === 'shutdown') {
    if (args[1].length === 0) return invalid();
    return { kind: 'shutdown', leaseId: args[1] };
  }
  return invalid();
}

function parseInstallerCommand(args: readonly string[]): InstallerCommand {
  if (args.length === 2 && args[0] === 'reconcile') {
    if (args[1].length === 0) return invalid();
    return { kind: 'reconcile', requestFile: args[1] };
  }
  if (args.length === 1 && args[0] === 'uninstall') {
    return { kind: 'uninstall', purgeData: false };
  }
  if (args.length === 2 && args[0] === 'uninstall' && args[1] === '--purge-data') {
    return { kind: 'uninstall', purgeData: true };
  }
  return invalid();
}
