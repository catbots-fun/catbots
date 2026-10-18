export function isForbidden(path: string): boolean;
export function findForbiddenEntries(directory: string, displayRoot: string): Promise<string[]>;
export function verifyPackageContents(artifactDirectory: string): Promise<void>;
export function verifyRequiredEntries(
  artifactDirectory: string,
  requiredEntries: readonly (
    | Readonly<{ kind: 'exact'; path: string }>
    | Readonly<{ kind: 'prefix'; path: string }>
  )[],
): Promise<void>;
