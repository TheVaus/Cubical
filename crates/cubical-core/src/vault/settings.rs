use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::Value as Json;

use super::VaultError;

pub type SettingsMap = BTreeMap<String, Json>;

pub fn to_toml(map: &SettingsMap) -> Result<String, VaultError> {
    let mut root = toml::value::Table::new();
    for (dotted, json) in map {
        if json.is_null() {
            continue;
        }
        insert_dotted(&mut root, dotted, json_to_toml(json));
    }
    toml::to_string_pretty(&toml::Value::Table(root))
        .map_err(|e| VaultError::Settings(format!("encode TOML: {e}")))
}

pub fn from_toml(src: &str) -> Result<SettingsMap, VaultError> {
    let value: toml::Value =
        toml::from_str(src).map_err(|e| VaultError::Settings(format!("parse TOML: {e}")))?;
    let mut out = SettingsMap::new();
    if let toml::Value::Table(t) = value {
        flatten(&t, String::new(), &mut out);
    }
    Ok(out)
}

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

pub fn is_workspace_key(key: &str) -> bool {
    key.starts_with("ui.")
}

pub fn settings_path(vault_root: &Path) -> PathBuf {
    vault_root.join(".cubical").join("config.toml")
}

pub fn load(vault_root: &Path) -> Result<SettingsMap, VaultError> {
    let path = settings_path(vault_root);
    match std::fs::read_to_string(&path) {
        Ok(src) => from_toml(&src),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(SettingsMap::new()),
        Err(e) => Err(VaultError::Settings(format!(
            "read {}: {e}",
            path.display()
        ))),
    }
}

pub fn save(vault_root: &Path, map: &SettingsMap) -> Result<(), VaultError> {
    let path = settings_path(vault_root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| VaultError::Settings(format!("mkdir {}: {e}", parent.display())))?;
    }
    let toml = to_toml(map)?;
    super::atomic::atomic_write(&path, toml.as_bytes())
}

fn json_to_toml(v: &Json) -> toml::Value {
    match v {
        Json::Bool(b) => toml::Value::Boolean(*b),
        Json::Number(n) if n.is_i64() => toml::Value::Integer(n.as_i64().unwrap()),
        Json::Number(n) => toml::Value::Float(n.as_f64().unwrap_or(0.0)),
        Json::String(s) => toml::Value::String(s.clone()),
        other => toml::Value::String(other.to_string()),
    }
}

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
    fn ui_keys_are_workspace_state_others_are_settings() {
        assert!(is_workspace_key("ui.right_sidebar_collapsed"));
        assert!(is_workspace_key("ui.right_sidebar_panel"));
        assert!(!is_workspace_key("appearance.theme_mode"));
        assert!(!is_workspace_key("plugins.dataview_enabled"));
        assert!(!is_workspace_key("editor.raw_source_default"));
    }

    #[test]
    fn load_missing_file_is_empty() {
        let dir = tempfile::TempDir::new().unwrap();
        assert!(load(dir.path()).unwrap().is_empty());
    }

    #[test]
    fn save_then_load_round_trips_and_creates_dirs() {
        let dir = tempfile::TempDir::new().unwrap();
        let mut m = SettingsMap::new();
        m.insert("plugins.dataview_enabled".into(), json!(false));
        save(dir.path(), &m).unwrap();
        assert!(settings_path(dir.path()).exists());
        assert_eq!(load(dir.path()).unwrap(), m);
    }

    #[test]
    fn load_malformed_file_errors() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::create_dir_all(dir.path().join(".cubical")).unwrap();
        std::fs::write(settings_path(dir.path()), "not = = valid").unwrap();
        assert!(load(dir.path()).is_err());
    }

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

    #[test]
    fn to_toml_omits_null_values() {
        let mut m = SettingsMap::new();
        m.insert("editor.raw_source_default".into(), json!(true));
        m.insert("some.unset".into(), Json::Null);
        let out = to_toml(&m).unwrap();
        assert!(!out.contains("unset"));
        let back = from_toml(&out).unwrap();
        assert!(!back.contains_key("some.unset"));
        assert_eq!(back.get("editor.raw_source_default"), Some(&json!(true)));
    }
}
