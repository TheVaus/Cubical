use std::sync::Arc;

use cubical_core::vault::settings::SettingsMap;
use tokio::sync::RwLock;

use crate::commands::open::with_open_vault;
use crate::error::CubicalError;
use crate::state::AppState;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Feature {
    Dataview,
    PropertyRefs,
    Math,
    Equations,
    Terminal,
    GraphView,
}

pub const ALL_FEATURES: [Feature; 6] = [
    Feature::Dataview,
    Feature::PropertyRefs,
    Feature::Math,
    Feature::Equations,
    Feature::Terminal,
    Feature::GraphView,
];

impl Feature {
    pub const fn id(self) -> &'static str {
        match self {
            Self::Dataview => "dataview",
            Self::PropertyRefs => "property-refs",
            Self::Math => "math",
            Self::Equations => "equations",
            Self::Terminal => "terminal",
            Self::GraphView => "graph-view",
        }
    }

    pub const fn setting_key(self) -> &'static str {
        match self {
            Self::Dataview => "plugins.dataview_enabled",
            Self::PropertyRefs => "plugins.property_refs_enabled",
            Self::Math => "plugins.math_enabled",
            Self::Equations => "plugins.equations_enabled",
            Self::Terminal => "plugins.terminal_enabled",
            Self::GraphView => "plugins.graph_view_enabled",
        }
    }

    pub const fn default_enabled(self) -> bool {
        match self {
            Self::Dataview => true,
            Self::PropertyRefs => true,
            Self::Math => true,
            Self::Equations => true,
            Self::Terminal => false,
            Self::GraphView => true,
        }
    }

    pub const fn requires(self) -> &'static [Feature] {
        match self {
            Self::Equations => &[Feature::PropertyRefs],
            _ => &[],
        }
    }
}

pub fn is_enabled(settings: &SettingsMap, feature: Feature) -> bool {
    settings
        .get(feature.setting_key())
        .and_then(|value| value.as_bool())
        .unwrap_or_else(|| feature.default_enabled())
}

pub fn is_active(settings: &SettingsMap, feature: Feature) -> bool {
    is_enabled(settings, feature)
        && feature
            .requires()
            .iter()
            .all(|required| is_enabled(settings, *required))
}

pub(crate) async fn ensure_active(
    settings: &RwLock<SettingsMap>,
    feature: Feature,
) -> Result<(), CubicalError> {
    let active = {
        let guard = settings.read().await;
        is_active(&guard, feature)
    };
    if active {
        Ok(())
    } else {
        Err(CubicalError::FeatureDisabled(feature.id().to_string()))
    }
}

pub async fn require(
    state: &AppState,
    vault_id: &str,
    feature: Feature,
) -> Result<(), CubicalError> {
    let settings = with_open_vault(state, vault_id, |open| Arc::clone(&open.settings)).await?;
    ensure_active(&settings, feature).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn with(pairs: &[(&str, bool)]) -> SettingsMap {
        let mut map = SettingsMap::new();
        for (key, value) in pairs {
            map.insert((*key).to_string(), json!(*value));
        }
        map
    }

    #[test]
    fn an_unset_key_falls_back_to_the_registry_default() {
        let empty = SettingsMap::new();
        assert!(is_active(&empty, Feature::Dataview));
        assert!(is_active(&empty, Feature::PropertyRefs));
        assert!(is_active(&empty, Feature::Math));
        assert!(is_active(&empty, Feature::Equations));
        assert!(is_active(&empty, Feature::GraphView));
        assert!(
            !is_active(&empty, Feature::Terminal),
            "the terminal is a capability gateway and must be off until asked for"
        );
    }

    #[test]
    fn a_non_boolean_value_falls_back_to_the_default() {
        let mut map = SettingsMap::new();
        map.insert("plugins.terminal_enabled".into(), json!("yes"));
        assert!(!is_active(&map, Feature::Terminal));
        map.insert("plugins.dataview_enabled".into(), json!(0));
        assert!(is_active(&map, Feature::Dataview));
    }

    #[test]
    fn a_stored_value_wins_over_the_default_in_both_directions() {
        assert!(is_active(
            &with(&[("plugins.terminal_enabled", true)]),
            Feature::Terminal
        ));
        assert!(!is_active(
            &with(&[("plugins.dataview_enabled", false)]),
            Feature::Dataview
        ));
    }

    #[test]
    fn a_feature_is_inactive_while_something_it_requires_is_off() {
        let map = with(&[("plugins.property_refs_enabled", false)]);
        assert!(is_enabled(&map, Feature::Equations));
        assert!(!is_active(&map, Feature::Equations));
    }

    #[test]
    fn every_feature_has_a_distinct_id_and_setting_key() {
        let mut ids: Vec<&str> = ALL_FEATURES.iter().map(|f| f.id()).collect();
        ids.sort_unstable();
        let before = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), before);

        let mut keys: Vec<&str> = ALL_FEATURES.iter().map(|f| f.setting_key()).collect();
        keys.sort_unstable();
        let before = keys.len();
        keys.dedup();
        assert_eq!(keys.len(), before);
        assert!(keys.iter().all(|k| k.starts_with("plugins.")));
    }

    #[test]
    fn the_backend_registry_matches_the_frontend_registry() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("ui")
            .join("src");
        let sources = [
            root.join("settings").join("corePlugins.ts"),
            root.join("terminal").join("registration.ts"),
            root.join("graph").join("registration.ts"),
        ];
        let mut frontend: Vec<(String, bool)> = Vec::new();
        for path in &sources {
            let text = std::fs::read_to_string(path)
                .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
            let mut rest = text.as_str();
            while let Some(at) = rest.find("settingKey:") {
                rest = &rest[at + "settingKey:".len()..];
                let Some(end) = rest.find("defaultEnabled:") else {
                    break;
                };
                let Some(key) = rest[..end].split('"').nth(1) else {
                    continue;
                };
                let tail = rest[end + "defaultEnabled:".len()..].trim_start();
                frontend.push((key.to_string(), tail.starts_with("true")));
            }
        }
        frontend.sort();

        let mut backend: Vec<(String, bool)> = ALL_FEATURES
            .iter()
            .map(|f| (f.setting_key().to_string(), f.default_enabled()))
            .collect();
        backend.sort();

        assert_eq!(
            backend, frontend,
            "ui/src/settings/corePlugins.ts and Feature must agree on every key and default"
        );
    }

    async fn state_with(vault_id: &str, settings: SettingsMap) -> (tempfile::TempDir, AppState) {
        use crate::state::{OpenVault, ScanStatusBackend};
        let dir = tempfile::tempdir().expect("tmpdir");
        let vault = cubical_core::Vault::open(dir.path()).await.expect("open");
        let state = AppState::new();
        state.vaults().write().await.insert(
            vault_id.to_string(),
            OpenVault::new(
                vault,
                tokio_util::sync::CancellationToken::new(),
                ScanStatusBackend::Complete,
                None,
                settings,
            ),
        );
        (dir, state)
    }

    #[tokio::test]
    async fn require_refuses_a_switched_off_feature_and_names_it() {
        let (_dir, state) = state_with("v1", SettingsMap::new()).await;
        let err = require(&state, "v1", Feature::Terminal)
            .await
            .expect_err("off by default");
        assert!(err.to_string().contains("terminal"));
        assert!(matches!(err, CubicalError::FeatureDisabled(id) if id == "terminal"));
    }

    #[tokio::test]
    async fn require_admits_a_feature_the_vault_switched_on() {
        let (_dir, state) = state_with("v1", with(&[("plugins.terminal_enabled", true)])).await;
        require(&state, "v1", Feature::Terminal)
            .await
            .expect("switched on");
    }

    #[tokio::test]
    async fn an_unopened_vault_is_still_vault_not_open() {
        let (_dir, state) = state_with("v1", SettingsMap::new()).await;
        let err = require(&state, "ghost", Feature::Dataview)
            .await
            .expect_err("unknown vault");
        assert!(matches!(err, CubicalError::VaultNotOpen(_)));
    }
}
