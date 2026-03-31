import type { CreateConfigValues } from "@paperclipai/adapter-utils";

export function buildClaudeK8sConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};

  // K8s-specific fields sourced from the directory field in the form (repurposed as namespace)
  if (v.directory) ac.namespace = v.directory;
  if (v.model) ac.model = v.model;
  if (v.instructionsFilePath) ac.instructionsFilePath = v.instructionsFilePath;
  if (v.promptTemplate) ac.promptTemplate = v.promptTemplate;

  if (v.maxTurnsPerRun > 0) ac.maxTurnsPerRun = v.maxTurnsPerRun;
  if (v.dangerouslySkipPermissions) ac.dangerouslySkipPermissions = true;

  if (v.extraArgs) {
    const args = v.extraArgs
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (args.length > 0) ac.extraArgs = args;
  }

  if (v.timeoutSec && v.timeoutSec > 0) ac.timeoutSec = v.timeoutSec;

  // Env vars
  if (v.envVars) {
    const env: Record<string, string> = {};
    for (const line of v.envVars.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq <= 0) continue;
      const key = t.slice(0, eq).trim();
      const val = t.slice(eq + 1);
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) env[key] = val;
    }
    if (Object.keys(env).length > 0) ac.env = env;
  }

  return ac;
}
