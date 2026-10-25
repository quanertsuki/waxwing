use crate::paths;
use serde::{Deserialize, Serialize};
use std::fs;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub name: String,
    #[serde(rename = "type")]
    pub provider_type: String,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key_env: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dsh_repo: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credentials_file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_tools: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_reasoning: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tool_requests: Option<u64>,
}

fn validate_provider_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.len() > 80
        || !name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err(
            "Provider name must contain only letters, digits, '-' and '_' (max 80 characters)"
                .to_string(),
        );
    }
    Ok(())
}

fn validate_provider_config(config: &ProviderConfig) -> Result<(), String> {
    validate_provider_name(&config.name)?;
    if !matches!(config.provider_type.as_str(), "openai-chat" | "dsh-sdk") {
        return Err(format!(
            "Unsupported provider type: {}",
            config.provider_type
        ));
    }
    if config.model.trim().is_empty() {
        return Err("Provider model is required".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn get_providers() -> Result<Vec<ProviderConfig>, String> {
    let dir = paths::providers_dir()?;
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut providers = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();

        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }

        let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        // Skip invalid provider files gracefully
        if let Ok(config) = serde_json::from_str::<ProviderConfig>(&content) {
            providers.push(config);
        }
    }

    Ok(providers)
}

#[tauri::command]
pub async fn save_provider(config: ProviderConfig) -> Result<(), String> {
    validate_provider_config(&config)?;
    let dir = paths::providers_dir()?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let file_path = dir.join(format!("{}.json", config.name));
    let mut value = paths::read_json_object(&file_path)?;
    for key in [
        "name",
        "type",
        "model",
        "baseUrl",
        "apiKeyEnv",
        "dshRepo",
        "credentialsFile",
        "contextWindow",
        "supportsTools",
        "supportsReasoning",
        "maxToolRequests",
    ] {
        value.remove(key);
    }
    if config.provider_type != "openai-chat" {
        value.remove("apiKey");
    }
    let serialized = serde_json::to_value(&config).map_err(|e| e.to_string())?;
    if let Some(fields) = serialized.as_object() {
        for (key, field) in fields {
            value.insert(key.clone(), field.clone());
        }
    }
    paths::write_json_object(&file_path, &value)?;

    Ok(())
}

#[tauri::command]
pub async fn delete_provider(name: String) -> Result<(), String> {
    validate_provider_name(&name)?;
    let file_path = paths::providers_dir()?.join(format!("{}.json", name));
    if file_path.exists() {
        fs::remove_file(&file_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
