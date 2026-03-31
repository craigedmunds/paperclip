export const type = "claude_k8s";
export const label = "Claude Code (Kubernetes)";

export const models = [
  { id: "claude-opus-4-5", label: "Claude Opus 4.5" },
  { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
];

export const agentConfigurationDoc = `# claude_k8s agent configuration

Adapter: claude_k8s

Use when:
- You need per-run K8s Job isolation instead of a shared server process
- Agents should have dedicated CPU/memory limits enforced by the scheduler
- Workspace isolation via PVC subPath per agent is required
- The deployment hosts multiple concurrent agents and process-sharing is a problem

Don't use when:
- The server has no K8s API access (e.g. local laptop development)
- You need the claude subscription auth flow (K8s pods need ANTHROPIC_API_KEY)
- The @kubernetes/client-node in-cluster config is not available (no ServiceAccount mounted)
- You only need a single agent with light load (claude_local is simpler)

Core fields:
- namespace (string, default "paperclip-agents"): K8s namespace for Job creation
- image (string, required): container image with claude CLI installed, e.g. "ghcr.io/craigedmunds/paperclip:latest"
- serviceAccount (string, default "paperclip-agent-runner"): ServiceAccount for the Job pod
- pvcName (string): shared RWX PVC name for workspace mounting; omit to skip workspace mount
- resources.requests.cpu (string, default "500m")
- resources.requests.memory (string, default "2Gi")
- resources.limits.cpu (string, default "2")
- resources.limits.memory (string, default "4Gi")
- model (string): claude model id, e.g. "claude-sonnet-4-5"
- maxTurnsPerRun (number): max turns passed to --max-turns
- dangerouslySkipPermissions (boolean, default false): pass --dangerously-skip-permissions
- instructionsFilePath (string): absolute path in the mounted workspace to the AGENTS.md file
- promptTemplate (string): mustache template for the heartbeat prompt
- graceSec (number, default 30): grace period for pod cleanup after timeout
- timeoutSec (number, default 0): total execution timeout in seconds (0 = no limit)
- jobTtlSec (number, default 300): TTL seconds for Jobs after completion (K8s ttlSecondsAfterFinished)
`;
