use crate::error::SearchError;
use crate::index::SearchIndex;
use crate::schema::Fields;
use serde::{Deserialize, Serialize};
use tantivy::collector::TopDocs;
use tantivy::query::{BooleanQuery, FuzzyTermQuery, Occur, Query, QueryParser, TermQuery};
use tantivy::schema::{Field, IndexRecordOption, TantivyDocument, Value};
use tantivy::snippet::SnippetGenerator;
use tantivy::{DocAddress, Order, Searcher, Term};

pub const LIMIT_MAX: usize = 500;
pub const LIMIT_DEFAULT: usize = 50;
pub const FUZZY_MIN_LEN: usize = 4;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SearchQuery {
    pub text: String,
    #[serde(default)]
    pub limit: usize,
    #[serde(default)]
    pub offset: usize,
    #[serde(default)]
    pub fields: FieldScope,
    #[serde(default)]
    pub fuzzy: bool,
    #[serde(default)]
    pub sort: SortMode,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FieldScope {
    #[default]
    Default,
    HeadingsOnly,
    BodyOnly,
    CodeOnly,
    Tags {
        tags: Vec<String>,
    },
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SortMode {
    #[default]
    Relevance,
    RecencyDesc,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchHit {
    pub path: String,
    pub title: String,
    pub score: f32,
    pub mtime_secs: i64,
    pub matched_fields: Vec<MatchedField>,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MatchedField {
    pub field: String,
    pub snippet: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResponse {
    pub hits: Vec<SearchHit>,
    pub total_estimated: u64,
    pub took_ms: u64,
    pub still_indexing: bool,
}

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

    let scope_fields: Option<Vec<Field>> = match &q.fields {
        FieldScope::Default => Some(vec![f.title, f.headings, f.body, f.tags, f.frontmatter]),
        FieldScope::HeadingsOnly => Some(vec![f.headings]),
        FieldScope::BodyOnly => Some(vec![f.body]),
        FieldScope::CodeOnly => Some(vec![f.code]),
        FieldScope::Tags { .. } => None,
    };

    let parsed: Box<dyn Query> = match (&q.fields, &scope_fields) {
        (FieldScope::Tags { tags }, _) => {
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
        (_, Some(scope_fields)) => {
            let mut p = QueryParser::for_index(idx.index(), scope_fields.clone());
            if matches!(q.fields, FieldScope::Default) {
                p.set_field_boost(f.title, 3.0);
                p.set_field_boost(f.headings, 2.0);
                p.set_field_boost(f.tags, 2.0);
            }
            let exact = p
                .parse_query(&prepare_query_text(&q.text))
                .map_err(|e| SearchError::QueryParse(e.to_string()))?;

            match simple_terms(&q.text) {
                Some(terms) => {
                    let prefix = build_prefix_query(&searcher, &terms, scope_fields)?;
                    Box::new(BooleanQuery::new(vec![
                        (Occur::Should, exact),
                        (Occur::Should, prefix),
                    ]))
                }
                None => exact,
            }
        }
        (_, None) => unreachable!("only the tags scope has no scope fields"),
    };

    let final_query: Box<dyn Query> = match (q.fuzzy, &scope_fields, single_term(&q.text)) {
        (true, Some(scope_fields), Some(term)) if term.chars().count() >= FUZZY_MIN_LEN => {
            let fuzzy = build_fuzzy_query(scope_fields, &term);
            Box::new(BooleanQuery::new(vec![
                (Occur::Should, parsed),
                (Occur::Should, fuzzy),
            ]))
        }
        _ => parsed,
    };

    let pulled: Vec<(f32, DocAddress)> = match q.sort {
        SortMode::Relevance => {
            let top = TopDocs::with_limit(limit + q.offset).order_by_score();
            searcher.search(final_query.as_ref(), &top)?
        }
        SortMode::RecencyDesc => {
            let top = TopDocs::with_limit(limit + q.offset)
                .order_by_fast_field::<i64>("mtime_secs", Order::Desc);
            let raw: Vec<(Option<i64>, DocAddress)> =
                searcher.search(final_query.as_ref(), &top)?;
            raw.into_iter()
                .map(|(mtime, addr)| (mtime.unwrap_or(0) as f32, addr))
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

fn simple_terms(text: &str) -> Option<Vec<String>> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut terms = Vec::new();
    for tok in trimmed.split_whitespace() {
        if tok.chars().all(char::is_alphanumeric) {
            terms.push(tok.to_lowercase());
        } else {
            return None;
        }
    }
    (!terms.is_empty()).then_some(terms)
}

fn build_prefix_query(
    searcher: &Searcher,
    terms: &[String],
    fields: &[Field],
) -> Result<Box<dyn Query>, SearchError> {
    let mut must: Vec<(Occur, Box<dyn Query>)> = Vec::with_capacity(terms.len());
    for term in terms {
        let mut per_field: Vec<(Occur, Box<dyn Query>)> = Vec::new();
        for &field in fields {
            for expanded in expand_prefix(searcher, field, term)? {
                let tq = TermQuery::new(expanded, IndexRecordOption::WithFreqs);
                per_field.push((Occur::Should, Box::new(tq)));
            }
        }
        must.push((Occur::Must, Box::new(BooleanQuery::new(per_field))));
    }
    Ok(Box::new(BooleanQuery::new(must)))
}

fn build_fuzzy_query(fields: &[Field], term: &str) -> Box<dyn Query> {
    let lowered = term.to_lowercase();
    let clauses: Vec<(Occur, Box<dyn Query>)> = fields
        .iter()
        .map(|&field| {
            let t = Term::from_field_text(field, &lowered);
            let q: Box<dyn Query> = Box::new(FuzzyTermQuery::new(t, 1, true));
            (Occur::Should, q)
        })
        .collect();
    Box::new(BooleanQuery::new(clauses))
}

fn expand_prefix(
    searcher: &Searcher,
    field: Field,
    prefix: &str,
) -> Result<Vec<Term>, SearchError> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for reader in searcher.segment_readers() {
        let inverted = reader.inverted_index(field)?;
        let dict = inverted.terms();
        let mut stream = dict.range().ge(prefix.as_bytes()).into_stream()?;
        while stream.advance() {
            let key = stream.key();
            if !key.starts_with(prefix.as_bytes()) {
                break;
            }
            if let Ok(s) = std::str::from_utf8(key) {
                if seen.insert(s.to_string()) {
                    out.push(Term::from_field_text(field, s));
                }
            }
        }
    }
    Ok(out)
}

fn prepare_query_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '#' && chars.peek().map(|n| n.is_alphanumeric()).unwrap_or(false) {
            continue;
        }
        out.push(c);
    }
    lowercase_after("tag:", &mut out);
    out
}

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

fn single_term(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.contains(char::is_whitespace) {
        None
    } else {
        Some(trimmed.to_string())
    }
}

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
    fn single_term_fuzzy_spans_all_fields() {
        let (_t, idx) = fixture_index();
        let run = |text: &str, fuzzy: bool| {
            run_search(
                &idx,
                &SearchQuery {
                    text: text.into(),
                    limit: 0,
                    offset: 0,
                    fields: FieldScope::Default,
                    fuzzy,
                    sort: SortMode::Relevance,
                },
            )
            .unwrap()
            .hits
            .len()
        };
        assert_eq!(run("quick", true), 1, "exact body word found, fuzzy ON");
        assert_eq!(run("quick", false), 1, "exact body word found, fuzzy OFF");
        assert_eq!(
            run("quikc", true),
            1,
            "transposition typo of a body word matches, fuzzy ON"
        );
        assert_eq!(
            run("quack", true),
            1,
            "one-substitution typo (quick→quack) matches, fuzzy ON"
        );
        assert_eq!(run("quikc", false), 0, "same typo finds nothing, fuzzy OFF");
    }

    #[test]
    fn prefix_of_a_word_matches() {
        let (_t, idx) = fixture_index();
        let run = |text: &str| {
            run_search(
                &idx,
                &SearchQuery {
                    text: text.into(),
                    limit: 0,
                    offset: 0,
                    fields: FieldScope::Default,
                    fuzzy: false,
                    sort: SortMode::Relevance,
                },
            )
            .unwrap()
            .hits
            .len()
        };
        assert_eq!(run("quick"), 1, "exact word still matches");
        assert_eq!(run("qui"), 1, "prefix of a body word matches");
        assert_eq!(run("brow"), 1, "prefix of another body word matches");
        assert_eq!(run("zzz"), 0, "non-matching prefix returns nothing");
    }

    #[test]
    fn prefix_matches_across_scoped_fields() {
        let (_t, idx) = fixture_index();
        let run = |text: &str, fields: FieldScope| {
            run_search(
                &idx,
                &SearchQuery {
                    text: text.into(),
                    limit: 0,
                    offset: 0,
                    fields,
                    fuzzy: false,
                    sort: SortMode::Relevance,
                },
            )
            .unwrap()
            .hits
            .len()
        };
        assert_eq!(run("sear", FieldScope::HeadingsOnly), 1);
        assert_eq!(run("alph", FieldScope::CodeOnly), 1);
        assert_eq!(run("brow", FieldScope::BodyOnly), 1);
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
