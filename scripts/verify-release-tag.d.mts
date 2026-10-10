export interface ReleaseTagOptions {
  eventName: string;
  inputTag?: string | undefined;
  refName?: string | undefined;
  packageVersion: string;
}

export function resolveAndValidateReleaseTag(options: ReleaseTagOptions): string;
