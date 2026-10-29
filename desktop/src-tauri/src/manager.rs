// One HTTP client for every desktop command. The token, URL, and timeout come
// from the paths the CLI resolved, so no command re-reads configuration.
use crate::paths;
use crate::transport::{error_message, health_from_result, ManagerHealth};

fn read_server_token(token_file: &str) -> Result<String, String> {
    std::fs::read_to_string(token_file)
        .map(|value| value.trim().to_string())
        .map_err(|error| format!("Cannot read server token at {token_file}: {error}"))
}

pub async fn request(action: &str, args: serde_json::Value) -> Result<serde_json::Value, String> {
    let location = paths::manager_paths()?;
    let token = read_server_token(&location.token_file)?;
    let client = reqwest::Client::new();
    let response = client
        .post(&location.manager_url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({"action": action, "args": args}))
        .send()
        .await
        .map_err(|error| format!("Manager request failed: {error}"))?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        return Err(error_message(status, &body));
    }

    response
        .json()
        .await
        .map_err(|error| format!("Invalid JSON response: {error}"))
}

pub async fn health() -> Result<ManagerHealth, String> {
    let location = paths::manager_paths()?;
    // Reading the token fails when no manager has written it yet.
    let token = match read_server_token(&location.token_file) {
        Ok(value) if !value.is_empty() => value,
        _ => return Ok(ManagerHealth::NotRunning),
    };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .post(&location.manager_url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({"action": "health", "args": {}}))
        .send()
        .await;
    let probe = match response {
        Ok(response) => {
            let status = response.status().as_u16();
            Ok((status, response.text().await.unwrap_or_default()))
        }
        Err(_) => Err(()),
    };
    Ok(health_from_result(probe))
}
