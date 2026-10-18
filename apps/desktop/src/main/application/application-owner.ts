export type ApplicationOwner = Readonly<{
  close(): Promise<void>;
}>;

export type ApplicationOwnerFactory = () => Promise<ApplicationOwner>;

export async function createApplicationOwner(
  construct: ApplicationOwnerFactory,
): Promise<ApplicationOwner> {
  return construct();
}
