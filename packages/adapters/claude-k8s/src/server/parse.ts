// Re-export all parse utilities from claude-local — the output format is identical
// (same claude CLI invoked in the K8s container).
export {
  parseClaudeStreamJson,
  describeClaudeFailure,
  isClaudeMaxTurnsResult,
  isClaudeUnknownSessionError,
} from "@paperclipai/adapter-claude-local/server";
