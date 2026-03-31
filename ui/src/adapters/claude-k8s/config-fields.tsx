import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  ToggleField,
  DraftInput,
  DraftNumberInput,
} from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function ClaudeK8sConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  return (
    <>
      <Field label="Container image" hint="Container image with claude CLI installed (e.g. ghcr.io/craigedmunds/paperclip:latest)">
        <DraftInput
          value={
            isCreate
              ? (values!.url ?? "")
              : eff("adapterConfig", "image", String(config.image ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ url: v })
              : mark("adapterConfig", "image", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="ghcr.io/craigedmunds/paperclip:latest"
        />
      </Field>
      <Field label="K8s namespace" hint="Namespace for Job creation (default: paperclip-agents)">
        <DraftInput
          value={
            isCreate
              ? (values!.directory ?? "")
              : eff("adapterConfig", "namespace", String(config.namespace ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ directory: v })
              : mark("adapterConfig", "namespace", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="paperclip-agents"
        />
      </Field>
      <Field label="ServiceAccount" hint="K8s ServiceAccount for the Job pod (default: paperclip-agent-runner)">
        <DraftInput
          value={
            isCreate
              ? ""
              : eff("adapterConfig", "serviceAccount", String(config.serviceAccount ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? undefined
              : mark("adapterConfig", "serviceAccount", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="paperclip-agent-runner"
        />
      </Field>
      <Field label="Workspace PVC name" hint="Shared RWX PVC for agent workspace (optional)">
        <DraftInput
          value={
            isCreate
              ? ""
              : eff("adapterConfig", "pvcName", String(config.pvcName ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? undefined
              : mark("adapterConfig", "pvcName", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="paperclip-agent-workspace"
        />
      </Field>
      <Field label="Agent instructions file" hint="Absolute path in the mounted workspace (e.g. /workspace/agents/my-agent/AGENTS.md)">
        <DraftInput
          value={
            isCreate
              ? (values!.instructionsFilePath ?? "")
              : eff("adapterConfig", "instructionsFilePath", String(config.instructionsFilePath ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ instructionsFilePath: v })
              : mark("adapterConfig", "instructionsFilePath", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="/workspace/agents/my-agent/AGENTS.md"
        />
      </Field>
      <Field label="Max turns per run" hint="Maximum conversation turns per heartbeat (0 = no limit)">
        <DraftNumberInput
          value={
            isCreate
              ? (values!.maxTurnsPerRun ?? 0)
              : Number(eff("adapterConfig", "maxTurnsPerRun", config.maxTurnsPerRun ?? 0))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ maxTurnsPerRun: v })
              : mark("adapterConfig", "maxTurnsPerRun", v || undefined)
          }
          min={0}
          className={inputClass}
        />
      </Field>
      <ToggleField
        label="Skip permissions"
        hint="Pass --dangerously-skip-permissions to claude CLI. Only for trusted environments."
        value={
          isCreate
            ? (values!.dangerouslySkipPermissions ?? false)
            : eff("adapterConfig", "dangerouslySkipPermissions", config.dangerouslySkipPermissions ?? false) === true
        }
        onChange={(v) =>
          isCreate
            ? set!({ dangerouslySkipPermissions: v })
            : mark("adapterConfig", "dangerouslySkipPermissions", v || undefined)
        }
      />
    </>
  );
}
