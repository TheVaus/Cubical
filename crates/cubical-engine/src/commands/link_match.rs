pub(crate) fn strip_md_suffix(path: &str) -> &str {
    path.strip_suffix(".md").unwrap_or(path)
}

pub(crate) fn basename_without_md(path: &str) -> &str {
    let after_slash = path.rsplit('/').next().unwrap_or(path);
    strip_md_suffix(after_slash)
}

pub(crate) fn link_name_forms(path: &str) -> (String, String) {
    (
        basename_without_md(path).to_string(),
        strip_md_suffix(path).to_string(),
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum CandidateRank {
    ExactPath,
    ExactBasename,
    CaseInsensitivePath,
    CaseInsensitiveBasename,
    FrontmatterTitle,
}

impl CandidateRank {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            CandidateRank::ExactPath => "exact_path",
            CandidateRank::ExactBasename => "exact_basename",
            CandidateRank::CaseInsensitivePath => "case_insensitive_path",
            CandidateRank::CaseInsensitiveBasename => "case_insensitive_basename",
            CandidateRank::FrontmatterTitle => "frontmatter_title",
        }
    }
}

pub(crate) fn classify_candidate(candidate_path: &str, token: &str) -> Option<CandidateRank> {
    let token = token.trim();
    if token.is_empty() {
        return None;
    }
    let (basename, path_no_md) = link_name_forms(candidate_path);
    if token == path_no_md {
        return Some(CandidateRank::ExactPath);
    }
    if token == basename {
        return Some(CandidateRank::ExactBasename);
    }
    if token.eq_ignore_ascii_case(&path_no_md) {
        return Some(CandidateRank::CaseInsensitivePath);
    }
    if token.eq_ignore_ascii_case(&basename) {
        return Some(CandidateRank::CaseInsensitiveBasename);
    }
    None
}

pub(crate) fn derive_reattach_token(target_raw: &str, to_path: &str) -> String {
    let basename = basename_without_md(to_path);
    if !target_raw.contains('/') && basename != target_raw {
        basename.to_string()
    } else {
        strip_md_suffix(to_path).to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::rename::reconnect_broken_links_to;
    use cubical_core::Vault;
    use libsql::params;
    use tempfile::tempdir;

    #[test]
    fn exact_path_outranks_exact_basename() {
        assert_eq!(
            classify_candidate("notes/plan.md", "notes/plan"),
            Some(CandidateRank::ExactPath)
        );
        assert_eq!(
            classify_candidate("notes/plan.md", "plan"),
            Some(CandidateRank::ExactBasename)
        );
    }

    #[test]
    fn case_insensitive_forms_rank_below_exact() {
        assert_eq!(
            classify_candidate("notes/Plan.md", "notes/plan"),
            Some(CandidateRank::CaseInsensitivePath)
        );
        assert_eq!(
            classify_candidate("notes/Plan.md", "PLAN"),
            Some(CandidateRank::CaseInsensitiveBasename)
        );
        assert!(CandidateRank::ExactPath < CandidateRank::CaseInsensitivePath);
        assert!(CandidateRank::CaseInsensitiveBasename < CandidateRank::FrontmatterTitle);
    }

    #[test]
    fn unrelated_and_empty_tokens_do_not_match() {
        assert!(classify_candidate("notes/plan.md", "roadmap").is_none());
        assert!(classify_candidate("notes/plan.md", "   ").is_none());
        assert!(classify_candidate("notes/plan.md", "plan.md").is_none());
    }

    #[test]
    fn reattach_token_keeps_bare_tokens_bare_and_disambiguates_collisions() {
        assert_eq!(
            derive_reattach_token("plan", "archive/roadmap.md"),
            "roadmap"
        );
        assert_eq!(
            derive_reattach_token("notes/plan", "archive/roadmap.md"),
            "archive/roadmap"
        );
        assert_eq!(derive_reattach_token("Dup", "other/Dup.md"), "other/Dup");
    }

    const MATRIX_PATHS: [&str; 3] = ["notes/plan.md", "Plan.md", "archive/old plan.md"];
    const MATRIX_TOKENS: [&str; 8] = [
        "plan",
        "Plan",
        "PLAN",
        "notes/plan",
        "notes/Plan",
        "old plan",
        "archive/old plan",
        "roadmap",
    ];

    #[tokio::test]
    async fn classification_agrees_with_the_reconnect_sql_predicate() {
        for candidate in MATRIX_PATHS {
            let dir = tempdir().unwrap();
            let vault = Vault::open(dir.path()).await.expect("open");
            let conn = vault.index().connection();
            conn.execute(
                "INSERT INTO files (
                     path, type_id, size_bytes, mtime_unix, content_hash,
                     inode, last_seen, created_at, updated_at
                 ) VALUES ('src.md', 'markdown', 0, 0, '', NULL, 0, 0, 0)",
                (),
            )
            .await
            .unwrap();
            for (i, token) in MATRIX_TOKENS.iter().enumerate() {
                conn.execute(
                    "INSERT INTO links \
                     (source_path, target_raw, target_path, is_embed, position) \
                     VALUES ('src.md', ?1, NULL, 0, ?2)",
                    params![*token, i as i64],
                )
                .await
                .unwrap();
            }

            let (basename, path_no_md) = link_name_forms(candidate);
            let tx = conn.transaction().await.unwrap();
            reconnect_broken_links_to(&tx, "reattached.md", &basename, &path_no_md)
                .await
                .unwrap();
            tx.commit().await.unwrap();

            let mut rows = conn
                .query(
                    "SELECT target_raw FROM links WHERE target_path = 'reattached.md' \
                     ORDER BY target_raw",
                    (),
                )
                .await
                .unwrap();
            let mut sql_matched: Vec<String> = Vec::new();
            while let Some(row) = rows.next().await.unwrap() {
                sql_matched.push(row.get(0).unwrap());
            }
            sql_matched.sort();

            let mut classified: Vec<String> = MATRIX_TOKENS
                .iter()
                .filter(|t| classify_candidate(candidate, t).is_some())
                .map(|t| (*t).to_string())
                .collect();
            classified.sort();

            assert_eq!(sql_matched, classified, "candidate {candidate}");
        }
    }
}
