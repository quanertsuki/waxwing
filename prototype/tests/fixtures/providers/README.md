# Test providers

These provider files are deterministic fixtures for the test suite. They point
at no live service, contain no credentials, and are loaded only when
`DSH_SUBAGENT_PROVIDERS_DIR` is set by the test isolation layer.

