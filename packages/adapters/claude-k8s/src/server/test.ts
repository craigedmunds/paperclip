import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import * as k8s from "@kubernetes/client-node";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const namespace = asString(config.namespace, "paperclip-agents");
  const image = asString(config.image, "");
  const serviceAccount = asString(config.serviceAccount, "paperclip-agent-runner");
  const pvcName = asString(config.pvcName, "");

  // Check required image field
  if (!image) {
    checks.push({
      code: "claude_k8s_image_missing",
      level: "error",
      message: "config.image is required but not set",
      hint: "Set image to the container image with claude CLI, e.g. ghcr.io/craigedmunds/paperclip:latest",
    });
  } else {
    checks.push({
      code: "claude_k8s_image_set",
      level: "info",
      message: `Container image configured: ${image}`,
    });
  }

  // Check K8s API connectivity
  let kc: k8s.KubeConfig | null = null;
  try {
    kc = new k8s.KubeConfig();
    try {
      kc.loadFromCluster();
      checks.push({
        code: "claude_k8s_kubeconfig_in_cluster",
        level: "info",
        message: "Loaded in-cluster K8s config (ServiceAccount mounted)",
      });
    } catch {
      kc.loadFromDefault();
      checks.push({
        code: "claude_k8s_kubeconfig_default",
        level: "warn",
        message: "Loaded K8s config from default (not in-cluster). Ensure KUBECONFIG or ~/.kube/config is configured.",
        hint: "In production K8s pods, in-cluster config is used automatically via mounted ServiceAccount.",
      });
    }
  } catch (err) {
    checks.push({
      code: "claude_k8s_kubeconfig_error",
      level: "error",
      message: "Failed to load K8s config",
      detail: err instanceof Error ? err.message : String(err),
      hint: "Ensure the Paperclip server pod has a ServiceAccount with permission to create Jobs.",
    });
  }

  // Check namespace accessibility
  if (kc) {
    try {
      const coreApi = kc.makeApiClient(k8s.CoreV1Api);
      await coreApi.readNamespace(namespace);
      checks.push({
        code: "claude_k8s_namespace_accessible",
        level: "info",
        message: `Namespace ${namespace} is accessible`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const is404 = msg.includes("404") || msg.includes("not found");
      checks.push({
        code: is404 ? "claude_k8s_namespace_missing" : "claude_k8s_namespace_error",
        level: "error",
        message: is404
          ? `Namespace ${namespace} does not exist`
          : `Cannot reach namespace ${namespace}: ${msg}`,
        hint: is404
          ? `Create the namespace: kubectl create namespace ${namespace}`
          : "Check RBAC permissions for the Paperclip server ServiceAccount.",
      });
    }

    // Check ServiceAccount exists
    try {
      const coreApi = kc.makeApiClient(k8s.CoreV1Api);
      await coreApi.readNamespacedServiceAccount(serviceAccount, namespace);
      checks.push({
        code: "claude_k8s_service_account_exists",
        level: "info",
        message: `ServiceAccount ${serviceAccount} exists in ${namespace}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const is404 = msg.includes("404") || msg.includes("not found");
      checks.push({
        code: "claude_k8s_service_account_missing",
        level: is404 ? "warn" : "warn",
        message: is404
          ? `ServiceAccount ${serviceAccount} not found in ${namespace}`
          : `Could not verify ServiceAccount: ${msg}`,
        hint: `Apply the K8s infra manifests to create the ServiceAccount (see k8s-lab/apps/paperclip-agents/).`,
      });
    }

    // Check PVC exists if configured
    if (pvcName) {
      try {
        const coreApi = kc.makeApiClient(k8s.CoreV1Api);
        await coreApi.readNamespacedPersistentVolumeClaim(pvcName, namespace);
        checks.push({
          code: "claude_k8s_pvc_exists",
          level: "info",
          message: `PVC ${pvcName} exists in ${namespace}`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const is404 = msg.includes("404") || msg.includes("not found");
        checks.push({
          code: "claude_k8s_pvc_missing",
          level: is404 ? "warn" : "warn",
          message: is404
            ? `PVC ${pvcName} not found in ${namespace}`
            : `Could not verify PVC: ${msg}`,
          hint: "Apply the K8s infra manifests to create the shared workspace PVC.",
        });
      }
    }

    // Check Job creation permission
    try {
      const authApi = kc.makeApiClient(k8s.AuthorizationV1Api);
      const review = await authApi.createSelfSubjectAccessReview({
        apiVersion: "authorization.k8s.io/v1",
        kind: "SelfSubjectAccessReview",
        spec: {
          resourceAttributes: {
            namespace,
            verb: "create",
            resource: "jobs",
            group: "batch",
          },
        },
      });
      const allowed = review.body.status?.allowed ?? false;
      checks.push({
        code: allowed ? "claude_k8s_job_create_allowed" : "claude_k8s_job_create_denied",
        level: allowed ? "info" : "error",
        message: allowed
          ? `Job creation is allowed in ${namespace}`
          : `Job creation is NOT allowed in ${namespace} — check RBAC for the Paperclip server ServiceAccount`,
        hint: allowed
          ? undefined
          : "Apply a Role/ClusterRole granting batch/jobs create in the namespace.",
      });
    } catch {
      checks.push({
        code: "claude_k8s_rbac_check_failed",
        level: "warn",
        message: "Could not verify Job creation RBAC (SelfSubjectAccessReview failed)",
        hint: "Manually verify: kubectl auth can-i create jobs --namespace " + namespace,
      });
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
