import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerToolRenderer((_toolName, next) => {
    const renderers = next();
    return renderers && { ...renderers, renderShell: "self" };
  });
}
