/**
 * Several capabilities of the harness are backed by third-party SDKs — the four model providers and
 * the Langfuse reporter. Installing `mcp-evaluator` should not pull all of them down when you use
 * one, so they are optional peer dependencies imported on first use. This turns a missing module
 * into an actionable install instruction rather than a stack trace.
 *
 * @param moduleName The package to import.
 * @param feature Human-readable name of the feature that needs it, e.g. `anthropic` or `langfuse`.
 * @param installHint Full install line to suggest. Defaults to installing `moduleName`.
 */
export async function importOptional<T>(
  moduleName: string,
  feature: string,
  installHint = `npm install ${moduleName}`
): Promise<T> {
  try {
    return (await import(moduleName)) as T;
  } catch (error) {
    if (isModuleNotFound(error, moduleName)) {
      throw new Error(
        `"${feature}" needs the optional peer dependency "${moduleName}".\n` +
          `Install it with:  ${installHint}`
      );
    }
    throw error;
  }
}

function isModuleNotFound(error: unknown, moduleName: string): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === 'ERR_MODULE_NOT_FOUND' ||
    code === 'MODULE_NOT_FOUND' ||
    error.message.includes(`Cannot find package '${moduleName}'`) ||
    error.message.includes(`Cannot find module '${moduleName}'`)
  );
}
