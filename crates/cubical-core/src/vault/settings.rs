//! The `.cubical/config.toml` settings file ⇄ in-memory map boundary.
//!
//! Settings are a flat map of dotted keys (`appearance.theme_mode`) to
//! JSON scalar values, mirroring the IPC shape. On disk they become
//! nested TOML tables. This module is pure + no-Tauri; the app layer owns
//! the in-memory copy and the IPC.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::Value as Json;

use super::VaultError;

/// Flat settings map: dotted key → JSON scalar value.
pub type SettingsMap = BTreeMap<String, Json>;

/// Serialize a flat dotted-key map to TOML with nested tables.
/// `{"appearance.theme_mode": "dark"}` → `[appearance]\ntheme_mode = "dark"`.
pub fn to_toml(map: &SettingsMap) -> Result<String, VaultError> {
    let mut root = toml::value::Table::new();
    for (dotted, json) in map {
        insert_dotted(&mut root, dotted, json_to_toml(json));
    }
    toml::to_string_pretty(&toml::Value::Table(root))
        .map_err(|e| VaultError::Settings(format!("encode TOML: {e}")))
}

/// Convert a JSON scalar to a TOML value. Non-scalar / unrepresentable
/// values fall back to their JSON string (forward-safety).
fn json_to_toml(v: &Json) -> toml::Value {
    match v {
        Json::Bool(b) => toml::Value::Boolean(*b),
        Json::Number(n) if n.is_i64() => toml::Value::Integer(n.as_i64().unwrap()),
        Json::Number(n) => toml::Value::Float(n.as_f64().unwrap_or(0.0)),
        Json::String(s) => toml::Value::String(s.clone()),
        other => toml::Value::String(other.to_string()),
    }
}

/// Insert `value` at a dotted path into a TOML table, creating sub-tables.
fn insert_dotted(table: &mut toml::value::Table, dotted: &str, value: toml::Value) {
    let mut parts = dotted.split('.').peekable();
    let mut cur = table;
    while let Some(part) = parts.next() {
        if parts.peek().is_none() {
            cur.insert(part.to_string(), value);
            return;
        }
        let entry = cur
            .entry(part.to_string())
            .or_insert_with(|| toml::Value::Table(toml::value::Table::new()));
        if !entry.is_table() {
            *entry = toml::Value::Table(toml::value::Table::new());
        }
        cur = entry.as_table_mut().unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn to_toml_nests_dotted_keys() {
        let mut m = SettingsMap::new();
        m.insert("appearance.theme_mode".into(), json!("dark"));
        m.insert("plugins.dataview_enabled".into(), json!(true));
        let out = to_toml(&m).unwrap();
        assert!(out.contains("[appearance]"));
        assert!(out.contains("theme_mode = \"dark\""));
        assert!(out.contains("[plugins]"));
        assert!(out.contains("dataview_enabled = true"));
    }
}
