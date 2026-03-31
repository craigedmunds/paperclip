// The output format is identical to claude-local (same claude CLI runs in the K8s pod).
// Re-export the claude-local stdout parser.
export { parseClaudeStdoutLine } from "@paperclipai/adapter-claude-local/ui";
