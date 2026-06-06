//! Query API and runner.
//!
//! Builds a Tantivy `QueryParser` over the schema's text fields with the
//! default-scope boosts `title^3 + headings^2 + tags^2 + body +
//! frontmatter`. `FieldScope` swaps the parser's default fields, `fuzzy:
//! true` rewrites single-term queries on `Default` into a
//! `FuzzyTermQuery` against `title`, and one `<mark>…</mark>` snippet per
//! matched text field is generated via `SnippetGenerator`.

use crate::error::SearchError;
use crate::index::SearchIndex;
use crate::schema::Fields;
use serde::{Deserialize, Serialize};
use tantivy::collector::TopDocs;
use tantivy::query::{BooleanQuery, FuzzyTermQuery, Occur, Query, QueryParser, TermQuery};
use tantivy::schema::{IndexRecordOption, TantivyDocument, Value};
use tantivy::{DocAddress, Order, Searcher, SnippetGenerator, Term};

/// Hard cap on `limit`.
pub const LIMIT_MAX: usize = 500;
/// Default `limit` when caller passes 0.
pub const LIMIT_DEFAULT: usize = 50;
/// Minimum term length (chars) for fuzzy matching.
pub const FUZZY_MIN_LEN: usize = 4;

/// Free-text query input.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SearchQuery {
    /// The user-typed query string.
    pub text: String,
    /// Page size. 0 → `LIMIT_DEFAULT`. >`LIMIT_MAX` → error.
    #[serde(default)]
    pub limit: usize,
    /// Pagination offset.
    #[serde(default)]
    pub offset: usize,
    /// Which fields to search.
    #[serde(default)]
    pub fields: FieldScope,
    /// Whether to apply edit-distance-1 fuzziness on single-term queries
    /// (≥`FUZZY_MIN_LEN` chars) under `FieldScope::Default`.
    #[serde(default)]
    pub fuzzy: bool,
    /// Sort order.
    #[serde(default)]
    pub sort: SortMode,
}

/// What to search.
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FieldScope {
    /// `title^3 + headings^2 + body + tags^2 + frontmatter`.
    #[default]
    Default,
    /// Restrict to `headings`.
    HeadingsOnly,
    /// Restrict to `body`.
    BodyOnly,
    /// Restrict to `code`.
    CodeOnly,
    /// Exact-match filter on `tags` (multi-valued AND, lowercased).
    Tags {
        /// Tags to require — each is lowercased before lookup so callers
        /// can pass display-cased values.
        tags: Vec<String>,
    },
}

/// Sort order for results.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SortMode {
    /// Descending BM25.
    #[default]
    Relevance,
    /// Descending `mtime_secs`.
    RecencyDesc,
}

/// One result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchHit {
    /// Vault-relative path.
    pub path: String,
    /// Display title.
    pub title: String,
    /// BM25 score, or — when `sort = RecencyDesc` — the `mtime_secs`
    /// value cast to `f32`. The cast is lossy above ~2^24 (≈Apr 1970),
    /// but ordering is still correct because Tantivy sorts on the i64
    /// *before* the cast; the public `f32` is intentionally opaque under
    /// `RecencyDesc` (callers should treat it as a sort-key remnant, not
    /// a meaningful score).
    pub score: f32,
    /// Unix-seconds modification time.
    pub mtime_secs: i64,
    /// Per-field highlighted snippets.
    pub matched_fields: Vec<MatchedField>,
    /// Stored tag values for the hit.
    pub tags: Vec<String>,
}

/// One snippet from one matched field.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MatchedField {
    /// Field name (`"title"`, `"headings"`, `"body"`, `"code"`,
    /// `"frontmatter"`).
    pub field: String,
    /// Up to ~150-char snippet with `<mark>…</mark>` highlights.
    pub snippet: String,
}

/// Wraps a hit list with metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResponse {
    /// Ranked hits, capped at `limit`.
    pub hits: Vec<SearchHit>,
    /// Size of the top-K hit window the runner pulled from Tantivy
    /// — i.e. `min(matches, limit + offset)`. **Not** the true match
    /// count in the index. Frontends must not display this as
    /// "X total results"; it's only useful as an "is there more after
    /// this page?" hint (`total_estimated == limit + offset` ⇒ likely
    /// more pages exist). A true count would require a `Count`
    /// collector on a second pass; L4-A doesn't pay that cost.
    pub total_estimated: u64,
    /// Elapsed milliseconds for this query.
    pub took_ms: u64,
    /// True if the index state was `Building` at query time. Set by the
    /// caller in `commands::search`; always `false` here.
    pub still_indexing: bool,
}

/// Run a query against `idx`.
pub fn run_search(idx: &SearchIndex, q: &SearchQuery) -> Result<SearchResponse, SearchError> {
    let started = std::time::Instant::now();
    let limit = match q.limit {
        0 => LIMIT_DEFAULT,
        n if n > LIMIT_MAX => {
            return Err(SearchError::LimitTooLarge {
                got: n,
                max: LIMIT_MAX,
            });
        }
        n => n,
    };
    if q.text.trim().is_empty() {
        return Ok(SearchResponse {
            hits: Vec::new(),
            total_estimated: 0,
            took_ms: started.elapsed().as_millis() as u64,
            still_indexing: false,
        });
    }

    let f = idx.fields();
    let reader = idx.reader_clone();
    let searcher = reader.searcher();

    // Build the parsed query for the chosen scope.
    let parsed: Box<dyn Query> = match &q.fields {
        FieldScope::Default => {
            let mut p = QueryParser::for_index(
                idx.index(),
                vec![f.title, f.headings, f.body, f.tags, f.frontmatter],
            );
            p.set_field_boost(f.title, 3.0);
            p.set_field_boost(f.headings, 2.0);
            p.set_field_boost(f.tags, 2.0);
            p.parse_query(&prepare_query_text(&q.text))
                .map_err(|e| SearchError::QueryParse(e.to_string()))?
        }
        FieldScope::HeadingsOnly => {
            let p = QueryParser::for_index(idx.index(), vec![f.headings]);
            p.parse_query(&prepare_query_text(&q.text))
                .map_err(|e| SearchError::QueryParse(e.to_string()))?
        }
        FieldScope::BodyOnly => {
            let p = QueryParser::for_index(idx.index(), vec![f.body]);
            p.parse_query(&prepare_query_text(&q.text))
                .map_err(|e| SearchError::QueryParse(e.to_string()))?
        }
        FieldScope::CodeOnly => {
            let p = QueryParser::for_index(idx.index(), vec![f.code]);
            p.parse_query(&prepare_query_text(&q.text))
                .map_err(|e| SearchError::QueryParse(e.to_string()))?
        }
        FieldScope::Tags { tags } => {
            // Exact-match AND across all requested tags. Tags are
            // indexed as `STRING` (untokenized) — lowercase the query
            // term to match the at-index normalization in `IndexDoc`.
            let clauses: Vec<(Occur, Box<dyn Query>)> = tags
                .iter()
                .map(|t| {
                    let term = Term::from_field_text(f.tags, &t.to_lowercase());
                    let q: Box<dyn Query> =
                        Box::new(TermQuery::new(term, IndexRecordOption::Basic));
                    (Occur::Must, q)
                })
                .collect();
            Box::new(BooleanQuery::new(clauses))
        }
    };

    // Fuzzy rewrite for single-term queries on Default scope.
    let final_query: Box<dyn Query> = if q.fuzzy {
        match (&q.fields, single_term(&q.text)) {
            (FieldScope::Default, Some(term)) if term.chars().count() >= FUZZY_MIN_LEN => {
                Box::new(FuzzyTermQuery::new(
                    Term::from_field_text(f.title, &term.to_lowercase()),
                    1,
                    true,
                ))
            }
            _ => parsed,
        }
    } else {
        parsed
    };

    // Collect (score, addr) pairs. Recency sort returns i64 mtime in place of
    // score — we cast to f32 to fit `SearchHit::score`.
    let pulled: Vec<(f32, DocAddress)> = match q.sort {
        SortMode::Relevance => {
            let top = TopDocs::with_limit(limit + q.offset);
            searcher.search(final_query.as_ref(), &top)?
        }
        SortMode::RecencyDesc => {
            let top = TopDocs::with_limit(limit + q.offset)
                .order_by_fast_field::<i64>("mtime_secs", Order::Desc);
            let raw: Vec<(i64, DocAddress)> = searcher.search(final_query.as_ref(), &top)?;
            raw.into_iter()
                .map(|(mtime, addr)| (mtime as f32, addr))
                .collect()
        }
    };

    let total_estimated = pulled.len() as u64;

    let mut hits = Vec::new();
    for (score, addr) in pulled.into_iter().skip(q.offset).take(limit) {
        let doc: TantivyDocument = searcher.doc(addr)?;
        let path = doc
            .get_first(f.path)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let title = doc
            .get_first(f.title)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| path.clone());
        let mtime_secs = doc
            .get_first(f.mtime_secs)
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let tags: Vec<String> = doc
            .get_all(f.tags)
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect();

        let matched_fields = collect_snippets(&searcher, final_query.as_ref(), &doc, f)?;
        hits.push(SearchHit {
            path,
            title,
            score,
            mtime_secs,
            matched_fields,
            tags,
        });
    }

    Ok(SearchResponse {
        hits,
        total_estimated,
        took_ms: started.elapsed().as_millis() as u64,
        still_indexing: false,
    })
}

/// Strip raw `#` from query text (`#project` → `project`) and lowercase
/// the right-hand-side of any `tag:Value`. `#` is a `QueryParser`
/// metacharacter; lowercasing matches the at-index normalization.
fn prepare_query_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '#' && chars.peek().map(|n| n.is_alphanumeric()).unwrap_or(false) {
            continue; // drop the '#'; keep the term
        }
        out.push(c);
    }
    lowercase_after("tag:", &mut out);
    out
}

/// Lowercase the run that follows each occurrence of `prefix`, stopping
/// at the next whitespace character.
fn lowercase_after(prefix: &str, s: &mut String) {
    let mut out = String::with_capacity(s.len());
    let mut rest = s.as_str();
    while let Some(idx) = rest.find(prefix) {
        out.push_str(&rest[..idx + prefix.len()]);
        let after = &rest[idx + prefix.len()..];
        let end = after.find(char::is_whitespace).unwrap_or(after.len());
        out.push_str(&after[..end].to_lowercase());
        rest = &after[end..];
    }
    out.push_str(rest);
    *s = out;
}

/// Returns the lone term in `text` if and only if `text` (after trimming)
/// is a single non-empty token without whitespace.
fn single_term(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.contains(char::is_whitespace) {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Build one `<mark>`-highlighted snippet per text field that produced
/// a non-empty match for `q` in `doc`. Fields with no matching terms or
/// no snippet content are silently skipped.
fn collect_snippets(
    searcher: &Searcher,
    q: &dyn Query,
    doc: &TantivyDocument,
    f: Fields,
) -> Result<Vec<MatchedField>, SearchError> {
    let mut out = Vec::new();
    for (name, field) in [
        ("title", f.title),
        ("headings", f.headings),
        ("body", f.body),
        ("code", f.code),
        ("frontmatter", f.frontmatter),
    ] {
        let mut generator = match SnippetGenerator::create(searcher, q, field) {
            Ok(g) => g,
            Err(_) => continue,
        };
        generator.set_max_num_chars(150);
        let snippet = generator.snippet_from_doc(doc);
        if snippet.is_empty() {
            continue;
        }
        // Tantivy 0.22 emits `<b>…</b>` by default; the design spec calls
        // for `<mark>…</mark>` semantics so the UI can style highlights
        // independently of bold text.
        let html = snippet
            .to_html()
            .replace("<b>", "<mark>")
            .replace("</b>", "</mark>");
        if !html.is_empty() {
            out.push(MatchedField {
                field: name.to_string(),
                snippet: html,
            });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::doc::IndexDoc;
    use tempfile::TempDir;

    fn fixture_index() -> (TempDir, SearchIndex) {
        let tmp = TempDir::new().unwrap();
        let idx = SearchIndex::open(tmp.path()).unwrap();
        for (p, title, body, code, tags, head) in [
            (
                "a.md",
                "Alpha Notes",
                "the quick brown fox",
                "fn alpha() {}",
                vec!["foo"],
                "Heading One",
            ),
            (
                "b.md",
                "Beta Notes",
                "another lazy dog",
                "fn beta() {}",
                vec!["bar"],
                "Heading Two",
            ),
            (
                "c.md",
                "Cubical",
                "cubical search proof",
                "let _ = cubical::query();",
                vec!["project/cubical"],
                "Search",
            ),
        ] {
            idx.upsert(&IndexDoc {
                path: p.into(),
                title: title.into(),
                headings: head.into(),
                body: body.into(),
                code: code.into(),
                tags: tags.into_iter().map(String::from).collect(),
                frontmatter: String::new(),
                mtime_secs: 1_717_000_000,
                size_bytes: 1024,
            })
            .unwrap();
        }
        idx.commit().unwrap();
        (tmp, idx)
    }

    #[test]
    fn empty_query_returns_empty() {
        let (_t, idx) = fixture_index();
        let r = run_search(
            &idx,
            &SearchQuery {
                text: "   ".into(),
                limit: 0,
                offset: 0,
                fields: FieldScope::Default,
                fuzzy: false,
                sort: SortMode::Relevance,
            },
        )
        .unwrap();
        assert!(r.hits.is_empty());
        assert_eq!(r.total_estimated, 0);
    }

    #[test]
    fn limit_over_max_errors() {
        let (_t, idx) = fixture_index();
        let err = run_search(
            &idx,
            &SearchQuery {
                text: "fox".into(),
                limit: 501,
                offset: 0,
                fields: FieldScope::Default,
                fuzzy: false,
                sort: SortMode::Relevance,
            },
        )
        .unwrap_err();
        assert!(matches!(
            err,
            SearchError::LimitTooLarge { got: 501, max: 500 }
        ));
    }

    #[test]
    fn default_scope_matches_body() {
        let (_t, idx) = fixture_index();
        let r = run_search(
            &idx,
            &SearchQuery {
                text: "fox".into(),
                limit: 0,
                offset: 0,
                fields: FieldScope::Default,
                fuzzy: false,
                sort: SortMode::Relevance,
            },
        )
        .unwrap();
        assert_eq!(r.hits.len(), 1);
        assert_eq!(r.hits[0].path, "a.md");
    }

    #[test]
    fn code_only_scope_matches_code_not_body() {
        let (_t, idx) = fixture_index();
        let r = run_search(
            &idx,
            &SearchQuery {
                text: "alpha".into(),
                limit: 0,
                offset: 0,
                fields: FieldScope::CodeOnly,
                fuzzy: false,
                sort: SortMode::Relevance,
            },
        )
        .unwrap();
        assert_eq!(r.hits.len(), 1);
        assert_eq!(r.hits[0].path, "a.md");
    }

    #[test]
    fn headings_only_scope() {
        let (_t, idx) = fixture_index();
        let r = run_search(
            &idx,
            &SearchQuery {
                text: "search".into(),
                limit: 0,
                offset: 0,
                fields: FieldScope::HeadingsOnly,
                fuzzy: false,
                sort: SortMode::Relevance,
            },
        )
        .unwrap();
        assert_eq!(r.hits.len(), 1);
        assert_eq!(r.hits[0].path, "c.md");
    }

    #[test]
    fn tag_scope_exact_match_lowercased() {
        let (_t, idx) = fixture_index();
        let r = run_search(
            &idx,
            &SearchQuery {
                text: "anything".into(),
                limit: 0,
                offset: 0,
                fields: FieldScope::Tags {
                    tags: vec!["Project/Cubical".into()],
                },
                fuzzy: false,
                sort: SortMode::Relevance,
            },
        )
        .unwrap();
        assert_eq!(r.hits.len(), 1);
        assert_eq!(r.hits[0].path, "c.md");
    }

    #[test]
    fn hash_prefix_stripped_from_free_text() {
        let (_t, idx) = fixture_index();
        let r = run_search(
            &idx,
            &SearchQuery {
                text: "#fox".into(),
                limit: 0,
                offset: 0,
                fields: FieldScope::Default,
                fuzzy: false,
                sort: SortMode::Relevance,
            },
        )
        .unwrap();
        assert_eq!(r.hits.len(), 1);
    }

    #[test]
    fn fuzzy_on_short_term_no_match_expansion() {
        let (_t, idx) = fixture_index();
        // 3-char term: below the fuzzy threshold so we fall through to the
        // parsed query, and "fxo" is not the same token as "fox" → no hits.
        let r = run_search(
            &idx,
            &SearchQuery {
                text: "fxo".into(),
                limit: 0,
                offset: 0,
                fields: FieldScope::Default,
                fuzzy: true,
                sort: SortMode::Relevance,
            },
        )
        .unwrap();
        assert!(r.hits.is_empty());
    }

    #[test]
    fn body_match_produces_highlighted_snippet() {
        // Regression for L4-B (§5 deviation #1 → option (a)): once
        // `body` is STORED, a body hit must yield a <mark>-bearing
        // snippet, not just a title snippet.
        let (_t, idx) = fixture_index();
        let r = run_search(
            &idx,
            &SearchQuery {
                text: "fox".into(),
                limit: 0,
                offset: 0,
                fields: FieldScope::Default,
                fuzzy: false,
                sort: SortMode::Relevance,
            },
        )
        .unwrap();
        assert_eq!(r.hits[0].path, "a.md");
        let body = r.hits[0]
            .matched_fields
            .iter()
            .find(|m| m.field == "body")
            .map(|m| m.snippet.as_str())
            .expect("body field should produce a snippet once STORED");
        assert!(
            body.contains("<mark>") && body.contains("</mark>"),
            "expected <mark> highlights in body snippet, got: {body}"
        );
    }

    #[test]
    fn headings_and_code_matches_produce_snippets() {
        let (_t, idx) = fixture_index();
        let h = run_search(
            &idx,
            &SearchQuery {
                text: "Heading".into(),
                limit: 0,
                offset: 0,
                fields: FieldScope::HeadingsOnly,
                fuzzy: false,
                sort: SortMode::Relevance,
            },
        )
        .unwrap();
        assert!(
            !h.hits.is_empty(),
            "expected hits for 'Heading' in HeadingsOnly scope"
        );
        assert!(h.hits[0]
            .matched_fields
            .iter()
            .any(|m| m.field == "headings" && m.snippet.contains("<mark>")));

        let c = run_search(
            &idx,
            &SearchQuery {
                text: "alpha".into(),
                limit: 0,
                offset: 0,
                fields: FieldScope::CodeOnly,
                fuzzy: false,
                sort: SortMode::Relevance,
            },
        )
        .unwrap();
        assert!(
            !c.hits.is_empty(),
            "expected hits for 'alpha' in CodeOnly scope"
        );
        assert!(c.hits[0]
            .matched_fields
            .iter()
            .any(|m| m.field == "code" && m.snippet.contains("<mark>")));
    }

    #[test]
    fn frontmatter_match_produces_snippet() {
        let tmp = TempDir::new().unwrap();
        let idx = SearchIndex::open(tmp.path()).unwrap();
        idx.upsert(&IndexDoc {
            path: "fm.md".into(),
            title: "FM Doc".into(),
            headings: String::new(),
            body: String::new(),
            code: String::new(),
            tags: vec![],
            frontmatter: "author znamarand".into(),
            mtime_secs: 1_717_000_000,
            size_bytes: 64,
        })
        .unwrap();
        idx.commit().unwrap();
        let r = run_search(
            &idx,
            &SearchQuery {
                text: "znamarand".into(),
                limit: 0,
                offset: 0,
                fields: FieldScope::Default,
                fuzzy: false,
                sort: SortMode::Relevance,
            },
        )
        .unwrap();
        assert!(
            !r.hits.is_empty(),
            "expected a hit for the frontmatter term"
        );
        assert!(r.hits[0]
            .matched_fields
            .iter()
            .any(|m| m.field == "frontmatter" && m.snippet.contains("<mark>")));
    }

    #[test]
    fn snippet_contains_mark_tags() {
        // As of L4-B all prose fields are STORED, so any matched text
        // field can yield a snippet. This test pins the title path: the
        // query matches `title` on "Alpha Notes" so we exercise the
        // `<b>` → `<mark>` post-processing on a title snippet.
        let (_t, idx) = fixture_index();
        let r = run_search(
            &idx,
            &SearchQuery {
                text: "Alpha".into(),
                limit: 0,
                offset: 0,
                fields: FieldScope::Default,
                fuzzy: false,
                sort: SortMode::Relevance,
            },
        )
        .unwrap();
        assert_eq!(r.hits[0].path, "a.md");
        let title_snippet = r.hits[0]
            .matched_fields
            .iter()
            .find(|m| m.field == "title")
            .map(|m| m.snippet.as_str())
            .expect("title field should produce a snippet for this query");
        assert!(
            title_snippet.contains("<mark>") && title_snippet.contains("</mark>"),
            "expected <mark>…</mark> highlights in snippet, got: {title_snippet}"
        );
    }
}
