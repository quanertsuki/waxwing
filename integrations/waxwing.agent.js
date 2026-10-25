// Magpie agent plugin for a locally installed Waxwing package. Magpie's plugin
// loader only resolves files beside the plugin, so this file must not import
// Node built-ins.
let pluginPath = decodeURIComponent(import.meta.url);
pluginPath = pluginPath
  .replace(/^file:\/\/\/([A-Za-z]:)/, "$1")
  .replace(/^file:\/\/\//, "/")
  .replace(/^file:\/\//, "");
const pluginDir = pluginPath.replace(/[\\/][^\\/]+$/, "");
const repoRoot = pluginDir.replace(/[\\/]integrations$/, "");
const isWindows = /^[A-Za-z]:[\\/]/.test(pluginDir);
const config = isWindows
  ? "$LOCALAPPDATA/Waxwing/providers/magpie.json"
  : pluginPath.startsWith("/Users/")
    ? "$HOME/Library/Application Support/Waxwing/providers/magpie.json"
    : "$HOME/.local/share/waxwing/providers/magpie.json";

export const agent = {
  id: "waxwing",
  name: "Waxwing",
  dir: repoRoot,
  config,
  model: "model",
  notice: "Waxwing reloads Provider configuration for every task; no service restart is required.",
};

export function connect({gateway}) {
  return {
    apiKey: gateway.key,
    baseUrl: gateway.url,
  };
}
