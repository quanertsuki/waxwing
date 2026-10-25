// Magpie runs agent plugins in a bare sandbox: no import.meta.url, no process,
// and no Node modules. Magpie expands ~ and $VAR in `dir` and `config`, so
// keep the checked-in plugin portable and set both variables before start-up.
export const agent = {
  id: "waxwing",
  name: "Waxwing",
  dir: "$WAXWING_REPO",
  config: "$WAXWING_PROVIDERS_DIR/magpie.json",
  model: "model",
  notice: "Waxwing reloads Provider configuration for every task; no service restart is required.",
};

export function connect({gateway}) {
  return {
    apiKey: gateway.key,
    baseUrl: gateway.url,
  };
}
