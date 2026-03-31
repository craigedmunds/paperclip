import type { UIAdapterModule } from "../types";
import { parseClaudeStdoutLine } from "@paperclipai/adapter-claude-k8s/ui";
import { buildClaudeK8sConfig } from "@paperclipai/adapter-claude-k8s/ui";
import { ClaudeK8sConfigFields } from "./config-fields";

export const claudeK8sUIAdapter: UIAdapterModule = {
  type: "claude_k8s",
  label: "Claude Code (Kubernetes)",
  parseStdoutLine: parseClaudeStdoutLine,
  ConfigFields: ClaudeK8sConfigFields,
  buildAdapterConfig: buildClaudeK8sConfig,
};
