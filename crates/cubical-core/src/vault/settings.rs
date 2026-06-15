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

/// Parse TOML into a flat dotted-key settings map.
pub fn from_toml(src: &str) -> Result<SettingsMap, VaultError> {
    let value: toml::Value =
        toml::from_str(src).map_err(|e| VaultError::Settings(format!("parse TOML: {e}")))?;
    let mut out = SettingsMap::new();
    if let toml::Value::Table(t) = value {
        flatten(&t, String::new(), &mut out);
    }
    Ok(out)
}

/// Convert a TOML scalar to a JSON value (inverse of `json_to_toml`).
fn toml_to_json(v: &toml::Value) -> Json {
    match v {
        toml::Value::Boolean(b) => Json::Bool(*b),
        toml::Value::Integer(i) => Json::Number((*i).into()),
        toml::Value::Float(f) => serde_json::Number::from_f64(*f)
            .map(Json::Number)
            .unwrap_or(Json::Null),
        toml::Value::String(s) => Json::String(s.clone()),
        other => Json::String(other.to_string()),
    }
}

/// Recursively flatten nested tables into dotted keys.
fn flatten(table: &toml::value::Table, prefix: String, out: &mut SettingsMap) {
    for (k, v) in table {
        let key = if prefix.is_empty() {
            k.clone()
        } else {
            format!("{prefix}.{k}")
        };
        match v {
            toml::Value::Table(t) => flatten(t, key, out),
            scalar => {
                out.insert(key, toml_to_json(scalar));
            }
        }
    }
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
    fn from_toml_flattens_to_dotted_keys() {
        let src = "[appearance]\ntheme_mode = \"dark\"\n\n[plugins]\ndataview_enabled = true\n";
        let m = from_toml(src).unwrap();
        assert_eq!(m.get("appearance.theme_mode"), Some(&json!("dark")));
        assert_eq!(m.get("plugins.dataview_enabled"), Some(&json!(true)));
    }

    #[test]
    fn from_toml_round_trips_scalars() {
        let mut m = SettingsMap::new();
        m.insert("editor.raw_source_default".into(), json!(false));
        m.insert("pending_rewrites.flush_interval_secs".into(), json!(30));
        let back = from_toml(&to_toml(&m).unwrap()).unwrap();
        assert_eq!(back, m);
    }

    #[test]
    fn from_toml_rejects_malformed() {
        assert!(from_toml("not = = valid").is_err());
    }

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
