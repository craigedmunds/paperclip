import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  asBoolean,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  renderTemplate,
  joinPromptSections,
} from "@paperclipai/adapter-utils/server-utils";
import * as k8s from "@kubernetes/client-node";
import type { IncomingMessage } from "node:http";
import {
  parseClaudeStreamJson,
  describeClaudeFailure,
  isClaudeMaxTurnsResult,
  isClaudeUnknownSessionError,
} from "./parse.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildKubeConfig(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  try {
    kc.loadFromCluster();
  } catch {
    kc.loadFromDefault();
  }
  return kc;
}

function jobName(runId: string): string {
  // K8s names: max 63 chars, lowercase alphanumeric and hyphens
  const safe = runId.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 50);
  return `ppc-${safe}`;
}

function buildEnv(
  runId: string,
  agent: AdapterExecutionContext["agent"],
  config: Record<string, unknown>,
  context: Record<string, unknown>,
  authToken: string | undefined,
  promptB64: string,
): k8s.V1EnvVar[] {
  const base = buildPaperclipEnv(agent);
  const envMap: Record<string, string> = { ...base, PAPERCLIP_RUN_ID: runId };

  // Context wake vars
  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim()) || "";
  const wakeReason = (typeof context.wakeReason === "string" && context.wakeReason.trim()) || "";
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim()) || "";
  const approvalId = (typeof context.approvalId === "string" && context.approvalId.trim()) || "";
  const approvalStatus = (typeof context.approvalStatus === "string" && context.approvalStatus.trim()) || "";
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    : [];

  if (wakeTaskId) envMap.PAPERCLIP_TASK_ID = wakeTaskId;
  if (wakeReason) envMap.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) envMap.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) envMap.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) envMap.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) envMap.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");

  // User-configured env overrides
  const envConfig = parseObject(config.env);
  for (const [k, v] of Object.entries(envConfig)) {
    if (typeof v === "string") envMap[k] = v;
  }

  // Inject auth token unless explicitly provided in config
  const hasExplicitApiKey =
    typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;
  if (!hasExplicitApiKey && authToken) {
    envMap.PAPERCLIP_API_KEY = authToken;
  }

  // Pass the base64-encoded prompt so the container can decode and pipe to claude
  envMap.PAPERCLIP_PROMPT_B64 = promptB64;

  return Object.entries(envMap).map(([name, value]) => ({ name, value }));
}

function buildJobSpec(opts: {
  name: string;
  namespace: string;
  image: string;
  serviceAccount: string;
  pvcName: string | null;
  agentId: string;
  envVars: k8s.V1EnvVar[];
  claudeArgs: string[];
  resources: { requestsCpu: string; requestsMem: string; limitsCpu: string; limitsMem: string };
  ttlSec: number;
  instructionsFilePath: string;
}): k8s.V1Job {
  const {
    name,
    namespace,
    image,
    serviceAccount,
    pvcName,
    agentId,
    envVars,
    claudeArgs,
    resources,
    ttlSec,
    instructionsFilePath,
  } = opts;

  const workspaceSubPath = `workspaces/${agentId}`;

  // The container reads prompt from env var (base64) and pipes to claude
  // We also handle the --append-system-prompt-file flag by pointing at the mounted workspace path
  const escapedArgs = claudeArgs.map((a) => a.replace(/'/g, "'\\''"));
  const argsStr = escapedArgs.map((a) => `'${a}'`).join(" ");
  const shellCmd = `printf '%s' "$(echo "$PAPERCLIP_PROMPT_B64" | base64 -d)" | claude --print - ${argsStr}`;

  const volumeMounts: k8s.V1VolumeMount[] = pvcName
    ? [{ name: "workspace", mountPath: "/workspace", subPath: workspaceSubPath }]
    : [];

  const volumes: k8s.V1Volume[] = pvcName
    ? [{ name: "workspace", persistentVolumeClaim: { claimName: pvcName } }]
    : [];

  // If instructionsFilePath points inside /workspace, it will be available via mount
  const extraEnv: k8s.V1EnvVar[] = instructionsFilePath
    ? [{ name: "PAPERCLIP_INSTRUCTIONS_FILE", value: instructionsFilePath }]
    : [];

  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name,
      namespace,
      labels: {
        "app.kubernetes.io/name": "paperclip-agent",
        "app.kubernetes.io/component": "agent-run",
        "paperclip.ai/agent-id": agentId.slice(0, 63),
      },
    },
    spec: {
      ttlSecondsAfterFinished: ttlSec,
      backoffLimit: 0,
      template: {
        metadata: {
          labels: {
            "app.kubernetes.io/name": "paperclip-agent",
            "paperclip.ai/agent-id": agentId.slice(0, 63),
            "paperclip.ai/job-name": name,
          },
        },
        spec: {
          restartPolicy: "Never",
          serviceAccountName: serviceAccount,
          containers: [
            {
              name: "agent",
              image,
              command: ["/bin/sh", "-c"],
              args: [shellCmd],
              env: [...envVars, ...extraEnv],
              resources: {
                requests: { cpu: resources.requestsCpu, memory: resources.requestsMem },
                limits: { cpu: resources.limitsCpu, memory: resources.limitsMem },
              },
              volumeMounts,
            },
          ],
          volumes,
        },
      },
    },
  };
}

async function waitForPod(
  coreApi: k8s.CoreV1Api,
  namespace: string,
  jobName: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const labelSelector = `paperclip.ai/job-name=${jobName}`;

  while (Date.now() < deadline) {
    const pods = await coreApi.listNamespacedPod(namespace, undefined, undefined, undefined, undefined, labelSelector);
    const pod = pods.body.items[0];
    if (pod?.metadata?.name) {
      const phase = pod.status?.phase ?? "";
      if (phase === "Running" || phase === "Succeeded" || phase === "Failed") {
        return pod.metadata.name;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(`Timed out waiting for pod from Job ${jobName} to start`);
}

async function streamPodLogs(
  coreApi: k8s.CoreV1Api,
  namespace: string,
  podName: string,
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>,
  timeoutMs: number,
): Promise<string> {
  const chunks: string[] = [];

  const res = await coreApi.readNamespacedPodLog(
    podName,
    namespace,
    "agent",
    false,
    undefined,
    undefined,
    undefined,
    true, // follow
    undefined,
    undefined,
    undefined,
  ) as unknown as { body: IncomingMessage };

  const stream = res.body;

  return new Promise((resolve, reject) => {
    let finished = false;
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          if (!finished) {
            finished = true;
            stream.destroy();
            resolve(chunks.join(""));
          }
        }, timeoutMs)
      : null;

    stream.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      chunks.push(text);
      onLog("stdout", text).catch(() => {});
    });

    stream.on("end", () => {
      if (!finished) {
        finished = true;
        if (timer) clearTimeout(timer);
        resolve(chunks.join(""));
      }
    });

    stream.on("error", (err: Error) => {
      if (!finished) {
        finished = true;
        if (timer) clearTimeout(timer);
        reject(err);
      }
    });
  });
}

async function getJobExitCode(batchApi: k8s.BatchV1Api, namespace: string, name: string): Promise<number> {
  try {
    const job = await batchApi.readNamespacedJob(name, namespace);
    const status = job.body.status;
    if ((status?.succeeded ?? 0) > 0) return 0;
    if ((status?.failed ?? 0) > 0) return 1;
    return 0;
  } catch {
    return 1;
  }
}

async function deleteJob(batchApi: k8s.BatchV1Api, namespace: string, name: string): Promise<void> {
  try {
    await batchApi.deleteNamespacedJob(name, namespace, undefined, undefined, undefined, undefined, "Foreground");
  } catch {
    // Best-effort cleanup; TTL will catch it if this fails
  }
}

// ---------------------------------------------------------------------------
// Main execute
// ---------------------------------------------------------------------------

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  const namespace = asString(config.namespace, "paperclip-agents");
  const image = asString(config.image, "");
  const serviceAccount = asString(config.serviceAccount, "paperclip-agent-runner");
  const pvcName = asString(config.pvcName, "") || null;
  const model = asString(config.model, "");
  const maxTurns = asNumber(config.maxTurnsPerRun, 0);
  const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, false);
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const timeoutSec = asNumber(config.timeoutSec, 0);
  const ttlSec = asNumber(config.jobTtlSec, 300);
  const resourcesConfig = parseObject(config.resources);
  const requestsConfig = parseObject(resourcesConfig.requests);
  const limitsConfig = parseObject(resourcesConfig.limits);
  const resources = {
    requestsCpu: asString(requestsConfig.cpu, "500m"),
    requestsMem: asString(requestsConfig.memory, "2Gi"),
    limitsCpu: asString(limitsConfig.cpu, "2"),
    limitsMem: asString(limitsConfig.memory, "4Gi"),
  };

  if (!image) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "claude_k8s: config.image is required but not set",
      errorCode: "invalid_config",
    };
  }

  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );
  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");

  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const renderedBootstrapPrompt =
    !runtimeSessionId && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const prompt = joinPromptSections([renderedBootstrapPrompt, sessionHandoffNote, renderedPrompt]);
  const promptB64 = Buffer.from(prompt, "utf8").toString("base64");

  // Build claude CLI args (no --resume in K8s mode — no persistent session storage in pod)
  const claudeArgs: string[] = ["--output-format", "stream-json", "--verbose"];
  if (dangerouslySkipPermissions) claudeArgs.push("--dangerously-skip-permissions");
  if (model) claudeArgs.push("--model", model);
  if (maxTurns > 0) claudeArgs.push("--max-turns", String(maxTurns));
  if (instructionsFilePath) claudeArgs.push("--append-system-prompt-file", instructionsFilePath);
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();
  if (extraArgs.length > 0) claudeArgs.push(...extraArgs);

  const kc = buildKubeConfig();
  const batchApi = kc.makeApiClient(k8s.BatchV1Api);
  const coreApi = kc.makeApiClient(k8s.CoreV1Api);

  const name = jobName(runId);
  const envVars = buildEnv(runId, agent, config, context, authToken, promptB64);

  const jobSpec = buildJobSpec({
    name,
    namespace,
    image,
    serviceAccount,
    pvcName,
    agentId: agent.id,
    envVars,
    claudeArgs,
    resources,
    ttlSec,
    instructionsFilePath,
  });

  if (onMeta) {
    await onMeta({
      adapterType: "claude_k8s",
      command: `k8s:${namespace}/${name}`,
      cwd: `/workspace/workspaces/${agent.id}`,
      commandNotes: [
        `K8s Job: ${namespace}/${name}`,
        `Image: ${image}`,
        `ServiceAccount: ${serviceAccount}`,
        `PVC: ${pvcName ?? "none"}`,
      ],
      prompt,
      promptMetrics: {
        promptChars: prompt.length,
        bootstrapPromptChars: renderedBootstrapPrompt.length,
        sessionHandoffChars: sessionHandoffNote.length,
        heartbeatPromptChars: renderedPrompt.length,
      },
      context,
    });
  }

  const startedAt = new Date().toISOString();
  let podName: string | null = null;
  let stdout = "";
  let timedOut = false;

  try {
    await batchApi.createNamespacedJob(namespace, jobSpec);
    await onLog("stdout", `[paperclip] Created K8s Job ${namespace}/${name}\n`);

    const podWaitMs = 60_000; // 60s to start
    podName = await waitForPod(coreApi, namespace, name, podWaitMs);
    await onLog("stdout", `[paperclip] Pod ${podName} is running\n`);

    if (onSpawn) {
      await onSpawn({ pid: 0, startedAt });
    }

    const logTimeoutMs = timeoutSec > 0 ? timeoutSec * 1000 : 0;
    try {
      stdout = await streamPodLogs(coreApi, namespace, podName, onLog, logTimeoutMs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await onLog("stderr", `[paperclip] Log stream error: ${msg}\n`);
      timedOut = msg.includes("timed out") || msg.includes("timeout");
    }

    if (timedOut) {
      return {
        exitCode: null,
        signal: null,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        errorCode: "timeout",
        resultJson: { stdout },
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await onLog("stderr", `[paperclip] K8s error: ${msg}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `K8s execution failed: ${msg}`,
      errorCode: "k8s_error",
    };
  } finally {
    deleteJob(batchApi, namespace, name).catch(() => {});
  }

  const exitCode = await getJobExitCode(batchApi, namespace, name);
  const parsedStream = parseClaudeStreamJson(stdout);
  const parsed = parsedStream.resultJson;

  if (!parsed) {
    return {
      exitCode,
      signal: null,
      timedOut: false,
      errorMessage:
        exitCode === 0
          ? "Failed to parse claude JSON output"
          : `Claude exited with code ${exitCode}`,
      resultJson: { stdout },
    };
  }

  if (parsed && isClaudeUnknownSessionError(parsed)) {
    // In K8s mode, we never resume sessions (no local storage), so this is unexpected.
    // Clear session and report the error.
    return {
      exitCode,
      signal: null,
      timedOut: false,
      errorMessage: describeClaudeFailure(parsed) ?? "Unknown session error in K8s pod",
      clearSession: true,
      resultJson: parsed,
    };
  }

  const clearSessionForMaxTurns = isClaudeMaxTurnsResult(parsed);

  return {
    exitCode,
    signal: null,
    timedOut: false,
    errorMessage:
      exitCode === 0
        ? null
        : describeClaudeFailure(parsed) ?? `Claude exited with code ${exitCode}`,
    usage: parsedStream.usage ?? undefined,
    sessionId: null, // K8s Jobs have no persistent session state
    sessionParams: null,
    provider: "anthropic",
    biller: "anthropic",
    model: parsedStream.model || model,
    billingType: "api",
    costUsd: parsedStream.costUsd ?? undefined,
    resultJson: parsed,
    summary: parsedStream.summary,
    clearSession: clearSessionForMaxTurns,
  };
}
