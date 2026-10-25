// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod paths;
mod providers;
mod settings;
mod tasks;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            tasks::get_tasks,
            tasks::get_task_detail,
            tasks::get_task_usage,
            tasks::get_task_view,
            tasks::create_task,
            tasks::rework_task,
            tasks::cleanup_worktree,
            tasks::cancel_task,
            tasks::close_task,
            tasks::accept_task,
            tasks::is_manager_running,
            tasks::start_manager,
            providers::get_providers,
            providers::save_provider,
            providers::delete_provider,
            settings::get_settings,
            settings::save_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
