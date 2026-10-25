use crate::paths;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub default_provider: String,
    pub fallback_provider: String,
    pub usage_limits: UsageLimits,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageLimits {
    pub enabled: bool,
    pub warn_cost_cny: f64,
    pub block_cost_cny: f64,
    pub warn_requests: u32,
    pub block_requests: u32,
}

fn default_settings() -> Settings {
    Settings {
        default_provider: "dsh-sdk".to_string(),
        fallback_provider: "dsh-sdk".to_string(),
        usage_limits: UsageLimits {
            enabled: false,
            warn_cost_cny: 3.0,
            block_cost_cny: 5.0,
            warn_requests: 100,
            block_requests: 160,
        },
    }
}

#[tauri::command]
pub async fn get_settings() -> Result<Settings, String> {
    let config = Value::Object(paths::effective_config()?);
    let defaults = default_settings();

    let settings = Settings {
        default_provider: config["defaultProvider"]
            .as_str()
            .unwrap_or(&defaults.default_provider)
            .to_string(),
        fallback_provider: config["fallbackProvider"]
            .as_str()
            .unwrap_or(&defaults.fallback_provider)
            .to_string(),
        usage_limits: UsageLimits {
            enabled: config["usageLimits"]["enabled"]
                .as_bool()
                .unwrap_or(defaults.usage_limits.enabled),
            warn_cost_cny: config["usageLimits"]["warnCostCny"]
                .as_f64()
                .unwrap_or(defaults.usage_limits.warn_cost_cny),
            block_cost_cny: config["usageLimits"]["blockCostCny"]
                .as_f64()
                .unwrap_or(defaults.usage_limits.block_cost_cny),
            warn_requests: config["usageLimits"]["warnRequests"]
                .as_u64()
                .unwrap_or(defaults.usage_limits.warn_requests as u64)
                as u32,
            block_requests: config["usageLimits"]["blockRequests"]
                .as_u64()
                .unwrap_or(defaults.usage_limits.block_requests as u64)
                as u32,
        },
    };

    Ok(settings)
}

#[tauri::command]
pub async fn save_settings(settings: Settings) -> Result<(), String> {
    let path = paths::local_config_path()?;
    let mut config = paths::read_json_object(&path)?;
    let mut usage_limits = config
        .get("usageLimits")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    config.insert(
        "defaultProvider".to_string(),
        Value::String(settings.default_provider),
    );
    config.insert(
        "fallbackProvider".to_string(),
        Value::String(settings.fallback_provider),
    );
    usage_limits.insert(
        "enabled".to_string(),
        Value::Bool(settings.usage_limits.enabled),
    );
    usage_limits.insert(
        "warnCostCny".to_string(),
        Value::from(settings.usage_limits.warn_cost_cny),
    );
    usage_limits.insert(
        "blockCostCny".to_string(),
        Value::from(settings.usage_limits.block_cost_cny),
    );
    usage_limits.insert(
        "warnRequests".to_string(),
        Value::from(settings.usage_limits.warn_requests),
    );
    usage_limits.insert(
        "blockRequests".to_string(),
        Value::from(settings.usage_limits.block_requests),
    );
    config.insert("usageLimits".to_string(), Value::Object(usage_limits));

    paths::write_json_object(&path, &config)?;

    Ok(())
}
