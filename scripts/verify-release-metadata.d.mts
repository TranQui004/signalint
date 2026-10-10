export interface VerifyReleaseMetadataOptions {
  rootDir?: string | undefined;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined> | undefined;
}

export interface VerifyReleaseMetadataResult {
  packageVersion: string;
  validatedTag?: string | undefined;
  packageName: string;
}

export function extractActionVersion(actionYmlContent: string): string | undefined;

export function verifyReleaseMetadata(
  options?: VerifyReleaseMetadataOptions,
): VerifyReleaseMetadataResult;
