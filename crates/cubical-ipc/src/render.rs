use crate::protocol::Outcome;

pub fn render(outcome: &Outcome, json: bool) -> i32 {
    match outcome {
        Outcome::Files(paths) => {
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(paths).unwrap_or_default()
                );
            } else {
                for p in paths {
                    println!("{p}");
                }
            }
            0
        }
        Outcome::Resolved { target, path } => match path {
            Some(p) => {
                if json {
                    println!("{}", serde_json::json!({ "target_path": p }));
                } else {
                    println!("{p}");
                }
                0
            }
            None => {
                eprintln!("unresolved: {target}");
                1
            }
        },
        Outcome::Backlinks(sources) => {
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(sources).unwrap_or_default()
                );
            } else {
                for s in sources {
                    println!("{s}");
                }
            }
            0
        }
        Outcome::Created(path) => {
            if json {
                println!("{}", serde_json::json!({ "path": path }));
            } else {
                println!("{path}");
            }
            0
        }
        Outcome::Wrote(path) => {
            if json {
                println!("{}", serde_json::json!({ "path": path }));
            } else {
                println!("wrote {path}");
            }
            0
        }
        Outcome::Renamed { to, pending_count } => {
            if json {
                println!(
                    "{}",
                    serde_json::json!({ "path": to, "pending_count": pending_count })
                );
            } else {
                println!("renamed -> {to}");
            }
            0
        }
        Outcome::Trashed(path) => {
            if !json {
                println!("trashed {path}");
            }
            0
        }
        Outcome::SettingSet(key) => {
            if !json {
                println!("set {key}");
            }
            0
        }
        Outcome::SettingGet { key, value } => match value {
            Some(v) => {
                println!("{}", serde_json::to_string(v).unwrap_or_default());
                0
            }
            None => {
                eprintln!("unset: {key}");
                1
            }
        },
        Outcome::UndoRename {
            op_id,
            removed,
            pending_count,
        } => {
            if json {
                println!(
                    "{}",
                    serde_json::json!({ "removed": removed, "pending_count": pending_count })
                );
            } else {
                println!("undid rename op {op_id} (removed {removed} rows)");
            }
            0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::Outcome;

    #[test]
    fn resolved_none_exits_one() {
        let code = render(
            &Outcome::Resolved {
                target: "X".into(),
                path: None,
            },
            false,
        );
        assert_eq!(code, 1);
    }

    #[test]
    fn resolved_some_exits_zero() {
        let code = render(
            &Outcome::Resolved {
                target: "X".into(),
                path: Some("X.md".into()),
            },
            false,
        );
        assert_eq!(code, 0);
    }

    #[test]
    fn setting_get_unset_exits_one() {
        let code = render(
            &Outcome::SettingGet {
                key: "k".into(),
                value: None,
            },
            false,
        );
        assert_eq!(code, 1);
    }

    #[test]
    fn created_exits_zero() {
        assert_eq!(render(&Outcome::Created("A.md".into()), false), 0);
        assert_eq!(render(&Outcome::Created("A.md".into()), true), 0);
    }
}
