// Settings are read from and written by the manager. Rust no longer parses the
// configuration files; it forwards the validated settings the Node side owns.
use crate::manager;
use serde::{Deserialize, Serialize};

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

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSettingsResult {
    pub saved: bool,
    pub restart_required: bool,
    pub settings: Settings,
}

#[tauri::command]
pub async fn get_settings() -> Result<Settings, String> {
    let result = manager::request("settings_get", serde_json::json!({})).await?;
    serde_json::from_value(result).map_err(|error| format!("Failed to parse settings: {error}"))
}

#[tauri::command]
pub async fn save_settings(settings: Settings) -> Result<SaveSettingsResult, String> {
    let result = manager::request(
        "settings_save",
        serde_json::to_value(settings).map_err(|error| error.to_string())?,
    )
    .await?;
    serde_json::from_value(result)
        .map_err(|error| format!("Failed to parse the saved settings: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_round_trip_through_the_manager_shape() {
        let settings: Settings = serde_json::from_value(serde_json::json!({
            "defaultProvider": "dsh-sdk",
            "fallbackProvider": "dsh-sdk",
            "usageLimits": {
                "enabled": false,
                "warnCostCny": 3,
                "blockCostCny": 5,
                "warnRequests": 100,
                "blockRequests": 160
            }
        }))
        .expect("settings must deserialize");

        assert_eq!(settings.default_provider, "dsh-sdk");
        assert_eq!(settings.usage_limits.block_requests, 160);

        let result: SaveSettingsResult = serde_json::from_value(serde_json::json!({
            "saved": true,
            "restartRequired": false,
            "localConfigPath": "C:/data/config.local.json",
            "settings": {
                "defaultProvider": "dsh-sdk",
                "fallbackProvider": "dsh-sdk",
                "usageLimits": {
                    "enabled": true,
                    "warnCostCny": 1,
                    "blockCostCny": 2,
                    "warnRequests": 3,
                    "blockRequests": 4
                }
            }
        }))
        .expect("save result must deserialize");

        assert!(result.saved);
        assert!(!result.restart_required);
    }
}
