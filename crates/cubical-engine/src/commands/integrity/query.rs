use std::collections::BTreeMap;

use libsql::params;

use crate::api::types::{
    DanglingLinkGroup, DanglingLinkOccurrence, ListDanglingLinksRequest, ListDanglingLinksResponse,
    RepairCandidate,
};
use crate::commands::link_match::{classify_candidate, CandidateRank};
use crate::error::CubicalError;
use crate::state::AppState;

use super::DANGLING_PREDICATE;

const DEFAULT_GROUP_LIMIT: usize = 200;
const MAX_CANDIDATES: usize = 5;

#[derive(Default)]
struct GroupAccumulator {
    total: i64,
    missing_path: Option<String>,
    occurrences: Vec<DanglingLinkOccurrence>,
}

pub async fn list_dangling_links(
    state: &AppState,
    req: ListDanglingLinksRequest,
) -> Result<ListDanglingLinksResponse, CubicalError> {
    let guard = state.vaults().read().await;
    let open = guard
        .get(&req.vault_id)
        .ok_or_else(|| CubicalError::VaultNotOpen(req.vault_id.clone()))?;
    let conn = open.vault.index().connection();

    let accumulated = accumulate_groups(conn).await?;
    if accumulated.is_empty() {
        return Ok(ListDanglingLinksResponse {
            groups: Vec::new(),
            truncated: false,
        });
    }

    let files = tracked_paths(conn).await?;
    let titles = frontmatter_titles(conn).await?;

    let mut groups: Vec<DanglingLinkGroup> = accumulated
        .into_iter()
        .map(|(target_raw, acc)| {
            let candidates = rank_candidates(&target_raw, &files, &titles);
            DanglingLinkGroup {
                target_raw,
                missing_path: acc.missing_path,
                total: acc.total,
                occurrences: acc.occurrences,
                candidates,
            }
        })
        .filter(|g| g.missing_path.is_some() || !g.candidates.is_empty())
        .collect();

    groups.sort_by(|a, b| {
        b.total
            .cmp(&a.total)
            .then_with(|| a.target_raw.cmp(&b.target_raw))
    });

    let limit = req
        .limit
        .map(|n| n as usize)
        .unwrap_or(DEFAULT_GROUP_LIMIT)
        .max(1);
    let truncated = groups.len() > limit;
    groups.truncate(limit);

    Ok(ListDanglingLinksResponse { groups, truncated })
}

async fn accumulate_groups(
    conn: &libsql::Connection,
) -> Result<BTreeMap<String, GroupAccumulator>, CubicalError> {
    let sql = format!(
        "SELECT target_raw, source_path, target_path, COUNT(*) FROM links \
         WHERE {DANGLING_PREDICATE} \
         GROUP BY target_raw, source_path, target_path \
         ORDER BY target_raw, source_path"
    );
    let mut rows = conn.query(&sql, ()).await?;
    let mut out: BTreeMap<String, GroupAccumulator> = BTreeMap::new();
    while let Some(row) = rows.next().await? {
        let target_raw: String = row.get(0)?;
        let source_path: String = row.get(1)?;
        let missing: Option<String> = row.get(2)?;
        let count: i64 = row.get(3)?;
        if target_raw.trim().is_empty() {
            continue;
        }
        let entry = out.entry(target_raw).or_default();
        entry.total += count;
        if let Some(path) = missing {
            entry.missing_path = match entry.missing_path.take() {
                Some(existing) if existing <= path => Some(existing),
                _ => Some(path),
            };
        }
        match entry
            .occurrences
            .iter_mut()
            .find(|o| o.source_path == source_path)
        {
            Some(existing) => existing.count += count,
            None => entry
                .occurrences
                .push(DanglingLinkOccurrence { source_path, count }),
        }
    }
    Ok(out)
}

async fn tracked_paths(conn: &libsql::Connection) -> Result<Vec<String>, CubicalError> {
    let mut rows = conn
        .query("SELECT path FROM files ORDER BY path", ())
        .await?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        out.push(row.get(0)?);
    }
    Ok(out)
}

async fn frontmatter_titles(
    conn: &libsql::Connection,
) -> Result<Vec<(String, String)>, CubicalError> {
    let mut rows = conn
        .query(
            "SELECT file_path, value FROM frontmatter WHERE LOWER(key) = ?1 ORDER BY file_path",
            params!["title"],
        )
        .await?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        let path: String = row.get(0)?;
        let raw: String = row.get(1)?;
        if let Some(title) = serde_json::from_str::<serde_json::Value>(&raw)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
        {
            out.push((path, title));
        }
    }
    Ok(out)
}

fn rank_candidates(
    target_raw: &str,
    files: &[String],
    titles: &[(String, String)],
) -> Vec<RepairCandidate> {
    let mut ranked: Vec<(CandidateRank, &str)> = files
        .iter()
        .filter_map(|path| classify_candidate(path, target_raw).map(|rank| (rank, path.as_str())))
        .collect();
    for (path, title) in titles {
        if ranked.iter().any(|(_, p)| *p == path.as_str()) {
            continue;
        }
        if title.trim().eq_ignore_ascii_case(target_raw.trim()) {
            ranked.push((CandidateRank::FrontmatterTitle, path.as_str()));
        }
    }
    ranked.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(b.1)));
    ranked.truncate(MAX_CANDIDATES);
    ranked
        .into_iter()
        .map(|(rank, path)| RepairCandidate {
            path: path.to_string(),
            rank: rank.as_str().to_string(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::super::fixtures::{drop_file_as_watcher_would, vault_with};
    use super::*;

    async fn list(state: &AppState) -> ListDanglingLinksResponse {
        list_dangling_links(
            state,
            ListDanglingLinksRequest {
                vault_id: "v1".into(),
                limit: None,
            },
        )
        .await
        .expect("ok")
    }

    fn shape(group: &DanglingLinkGroup) -> Vec<(&str, &str)> {
        group
            .candidates
            .iter()
            .map(|c| (c.path.as_str(), c.rank.as_str()))
            .collect()
    }

    #[tokio::test]
    async fn ambiguous_token_is_reported_with_ranked_candidates() {
        let (_dir, _vault, state) = vault_with(&[
            ("src.md", "see [[plan]]\n"),
            ("notes/plan.md", "one\n"),
            ("archive/plan.md", "two\n"),
        ])
        .await;

        let resp = list(&state).await;
        assert_eq!(resp.groups.len(), 1);
        let g = &resp.groups[0];
        assert_eq!(g.target_raw, "plan");
        assert!(g.missing_path.is_none());
        assert_eq!(g.total, 1);
        assert_eq!(g.occurrences.len(), 1);
        assert_eq!(g.occurrences[0].source_path, "src.md");
        assert_eq!(
            shape(g),
            vec![
                ("archive/plan.md", "exact_basename"),
                ("notes/plan.md", "exact_basename"),
            ]
        );
        assert!(!resp.truncated);
    }

    #[tokio::test]
    async fn resolvable_and_never_created_links_are_not_reported() {
        let (_dir, _vault, state) = vault_with(&[
            ("src.md", "see [[plan]] and [[some future note]]\n"),
            ("notes/plan.md", "one\n"),
        ])
        .await;

        let resp = list(&state).await;
        assert!(resp.groups.is_empty());
    }

    #[tokio::test]
    async fn removed_target_leaves_a_stale_group_with_a_title_candidate() {
        let (dir, vault, state) = vault_with(&[
            ("src.md", "see [[plan]]\n"),
            ("notes/plan.md", "one\n"),
            ("archive/roadmap.md", "---\ntitle: plan\n---\ntwo\n"),
        ])
        .await;
        drop_file_as_watcher_would(&dir, &vault, "notes/plan.md").await;

        let resp = list(&state).await;
        assert_eq!(resp.groups.len(), 1);
        let g = &resp.groups[0];
        assert_eq!(g.target_raw, "plan");
        assert_eq!(g.missing_path.as_deref(), Some("notes/plan.md"));
        assert_eq!(shape(g), vec![("archive/roadmap.md", "frontmatter_title")]);
    }

    #[tokio::test]
    async fn groups_are_capped_and_report_truncation() {
        let (_dir, _vault, state) = vault_with(&[
            ("src.md", "[[plan]] [[Dup]]\n"),
            ("notes/plan.md", "one\n"),
            ("archive/plan.md", "two\n"),
            ("a/Dup.md", "three\n"),
            ("b/Dup.md", "four\n"),
        ])
        .await;

        let resp = list_dangling_links(
            &state,
            ListDanglingLinksRequest {
                vault_id: "v1".into(),
                limit: Some(1),
            },
        )
        .await
        .expect("ok");
        assert_eq!(resp.groups.len(), 1);
        assert!(resp.truncated);
    }

    #[tokio::test]
    async fn unknown_vault_errors() {
        let (_dir, _vault, state) = vault_with(&[("src.md", "hi\n")]).await;
        let err = list_dangling_links(
            &state,
            ListDanglingLinksRequest {
                vault_id: "ghost".into(),
                limit: None,
            },
        )
        .await
        .expect_err("should be VaultNotOpen");
        assert!(matches!(err, CubicalError::VaultNotOpen(v) if v == "ghost"));
    }
}
