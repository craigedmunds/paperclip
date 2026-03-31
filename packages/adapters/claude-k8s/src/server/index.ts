export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";
export {
  parseClaudeStreamJson,
  describeClaudeFailure,
  isClaudeMaxTurnsResult,
  isClaudeUnknownSessionError,
} from "./parse.js";

import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

// claude_k8s does not persist sessions across runs (K8s Jobs are ephemeral).
// Session state is always null.
export const sessionCodec: AdapterSessionCodec = {
  deserialize() {
    return null;
  },
  serialize() {
    return null;
  },
  getDisplayId() {
    return null;
  },
};
