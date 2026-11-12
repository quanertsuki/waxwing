// Provider files are owned by the manager. These commands only forward the
// request, so the desktop and the task runner validate with the same rules.
use crate::manager;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub name: String,
    #[serde(rename = "type")]
    pub provider_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key_env: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dsh_repo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credentials_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_tools: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_reasoning: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tool_requests: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream: Option<bool>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvalidProvider {
    pub file: String,
    pub error: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvidersResponse {
    pub providers: Vec<ProviderConfig>,
    pub invalid: Vec<InvalidProvider>,
}

#[tauri::command]
pub async fn get_providers() -> Result<ProvidersResponse, String> {
    let result = manager::request("providers_list", serde_json::json!({})).await?;
    serde_json::from_value(result)
        .map_err(|error| format!("Failed to parse the provider list: {error}"))
}

#[tauri::command]
pub async fn validate_provider(config: ProviderConfig) -> Result<serde_json::Value, String> {
    manager::request("provider_validate", serde_json::json!({"config": config})).await
}

#[tauri::command]
pub async fn save_provider(config: ProviderConfig) -> Result<serde_json::Value, String> {
    manager::request("provider_save", serde_json::json!({"config": config})).await
}

#[tauri::command]
pub async fn delete_provider(name: String) -> Result<serde_json::Value, String> {
    manager::request("provider_delete", serde_json::json!({"name": name})).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_provider_without_a_model_still_deserializes() {
        // The task runner accepts provider files without a model, so the
        // desktop contract must not reject what the manager can load.
        let config: ProviderConfig =
            serde_json::from_value(serde_json::json!({"name": "local", "type": "dsh-sdk"}))
                .expect("provider must deserialize");

        assert_eq!(config.name, "local");
        assert!(config.model.is_none());
        assert!(config.stream.is_none());
    }

    #[test]
    fn every_manager_field_reaches_the_desktop_shape() {
        let config: ProviderConfig = serde_json::from_value(serde_json::json!({
            "name": "remote",
            "type": "openai-chat",
            "model": "model-x",
            "baseUrl": "https://example.invalid",
            "apiKeyEnv": "KEY",
            "dshRepo": "C:/dsh",
            "credentialsFile": "C:/dsh/.credentials.yaml",
            "contextWindow": 64000,
            "supportsTools": true,
            "supportsReasoning": false,
            "maxToolRequests": 8,
            "stream": true
        }))
        .expect("provider must deserialize");

        assert!(config.stream.unwrap_or(false));
        assert!(config.supports_tools.unwrap_or(false));
        assert_eq!(config.max_tool_requests, Some(8));
    }
}
