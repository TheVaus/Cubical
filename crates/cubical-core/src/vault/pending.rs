//! Pure materializer for the L3 Session J pending-rewrites cache
//! (spec §2.10, design `docs/superpowers/specs/2026-05-31-l3-session-j-pending-rewrites-design.md`).
//!
//! Pure: no I/O, no DB. Given a markdown source string + a list of
//! [`PendingRewriteRow`]s (in `created_at` order), [`apply_pending`]
//! returns the post-rewrite source. [`materialize_on_read`] is the
//! thin async wrapper that pulls pending rows for `path` from the
//! libSQL index and feeds them through [`apply_pending`].
//!
//! Three rewrite kinds, dispatched by [`RewriteKind`]:
//!
//! - [`RewriteKind::WikiLink`] — `old_token` / `new_token` are bare
//!   wiki-link targets (no `[[`, no `|display`, no `#anchor`). Walks
//!   the source through `cubical_ast::wikilink::scan_wikilinks` and
//!   re-emits any [`TokenizedRun::WikiLink`] whose `target` equals
//!   `old_token`, preserving the embed (`!`) flag, `|display`, and
//!   `#anchor`.
//! - [`RewriteKind::Tag`] — `old_token` / `new_token` are tag paths
//!   without the leading `#` (e.g. `"work/active"`). Two passes per
//!   row: (1) a minimal targeted rewrite of `tags:` list entries
//!   inside the frontmatter block (preserves user formatting because
//!   we operate on the raw block text rather than re-emitting YAML);
//!   (2) an inline body pass over [`extract_text_runs`] applying the
//!   Session D tag boundary rules and the exact-match-or-nested-prefix
//!   substitution.
//! - [`RewriteKind::BlockRef`] — `old_token` / `new_token` are bare
//!   block ids without `^`. Two patterns: (1) referrer `[[file#^old]]`
//!   rewrites via `scan_wikilinks`; (2) defining-line `^old` at the
//!   trailing-token position rewrites via a line walk. Both patterns
//!   are attempted per row; the defining-line pattern can only match
//!   in the defining file's own source, which is what makes a single
//!   uniform pass safe per the spec.

use std::borrow::Cow;

use cubical_ast::{scan_wikilinks, Anchor, TokenizedRun};
use cubical_index::{IndexConn, IndexError, PendingRewriteRow, RewriteKind};

use crate::vault::mentions::extract_text_runs;

/// Apply a sequence of pending rewrites to a source string, in slice
/// order. Pure: no I/O. Returns the post-rewrite source.
///
/// Each rewrite produces a new full string that becomes the input to
/// the next rewrite. This is O(n_rewrites × source_len) which is fine
/// for the spec's ≤50-per-file ceiling (`docs/architecture/document-model.md`
/// §5.7).
#[must_use]
pub fn apply_pending(source: &str, rewrites: &[PendingRewriteRow]) -> String {
    if rewrites.is_empty() {
        return source.to_string();
    }
    let mut current: Cow<'_, str> = Cow::Borrowed(source);
    for r in rewrites {
        let next = match r.rewrite_kind {
            RewriteKind::WikiLink => rewrite_wiki_link(&current, &r.old_token, &r.new_token),
            RewriteKind::Tag => rewrite_tag(&current, &r.old_token, &r.new_token),
            RewriteKind::BlockRef => rewrite_block_ref(&current, &r.old_token, &r.new_token),
        };
        if let Some(updated) = next {
            current = Cow::Owned(updated);
        }
    }
    current.into_owned()
}

/// Pull pending rows for `path` and apply them to `on_disk`. Returns
/// `on_disk` unchanged when no rows are pending.
pub async fn materialize_on_read(
    idx: &IndexConn,
    path: &str,
    on_disk: &str,
) -> Result<String, IndexError> {
    let rows = cubical_index::pending_for_target(idx, path).await?;
    if rows.is_empty() {
        return Ok(on_disk.to_string());
    }
    Ok(apply_pending(on_disk, &rows))
}

// ---- Wiki-link kind -------------------------------------------------

/// Rebuild `source` substituting wiki-links whose `target` equals
/// `old_token` to use `new_token`. Returns `None` if there were no
/// matches (allows the caller to keep the borrowed `Cow`).
fn rewrite_wiki_link(source: &str, old_token: &str, new_token: &str) -> Option<String> {
    if old_token.is_empty() {
        return None;
    }
    let runs = scan_wikilinks(source);
    let mut hits = 0usize;
    // Pre-walk to count hits so we can skip the rebuild allocation
    // entirely when nothing matches. The walk is cheap relative to
    // string assembly.
    for run in &runs {
        match run {
            TokenizedRun::WikiLink { target, .. } if target == old_token => hits += 1,
            // A property ref `[[note.prop]]` follows the rename when either
            // its note part is the renamed note, OR its whole dotted target
            // names a renamed *file* (`[[Report v1.2]]` → file
            // `Report v1.2.md`). Both would break otherwise.
            TokenizedRun::PropertyRef {
                note: Some(n),
                property,
            } if n == old_token || format!("{n}.{property}") == old_token => hits += 1,
            _ => {}
        }
    }
    if hits == 0 {
        return None;
    }

    let mut out = String::with_capacity(source.len());
    for run in runs {
        match run {
            TokenizedRun::Text(t) => out.push_str(&t),
            TokenizedRun::WikiLink {
                target,
                display,
                anchor,
                embed,
            } => {
                let effective_target = if target == old_token {
                    new_token.to_string()
                } else {
                    target
                };
                emit_wikilink(&mut out, &effective_target, &display, &anchor, embed);
            }
            TokenizedRun::PropertyRef { note, property } => {
                // Whole dotted target names a renamed file → re-emit as a
                // plain wiki-link with the new name. Otherwise fall back to
                // the note-part rename (the property-ref feature's
                // semantics). The two are keyed on different `old_token`
                // shapes, so they never both fire.
                let whole_is_file = note
                    .as_ref()
                    .is_some_and(|n| format!("{n}.{property}") == old_token);
                if whole_is_file {
                    emit_wikilink(&mut out, new_token, &None, &None, false);
                } else {
                    let effective_note = match &note {
                        Some(n) if n == old_token => Some(new_token.to_string()),
                        other => other.clone(),
                    };
                    emit_property_ref(&mut out, &effective_note, &property);
                }
            }
        }
    }
    Some(out)
}

/// Re-emit a property-reference token to its on-disk form
/// (`[[note.prop]]` / `[[.prop]]`).
fn emit_property_ref(out: &mut String, note: &Option<String>, property: &str) {
    out.push_str("[[");
    if let Some(n) = note {
        out.push_str(n);
    }
    out.push('.');
    out.push_str(property);
    out.push_str("]]");
}

/// Re-emit a wiki-link token to its on-disk form.
fn emit_wikilink(
    out: &mut String,
    target: &str,
    display: &Option<String>,
    anchor: &Option<Anchor>,
    embed: bool,
) {
    if embed {
        out.push('!');
    }
    out.push_str("[[");
    out.push_str(target);
    if let Some(a) = anchor {
        out.push('#');
        match a {
            Anchor::Heading { value } => out.push_str(value),
            Anchor::Block { value } => {
                out.push('^');
                out.push_str(value);
            }
        }
    }
    if let Some(d) = display {
        out.push('|');
        out.push_str(d);
    }
    out.push_str("]]");
}

// ---- Tag kind -------------------------------------------------------

/// Rewrite `#old_token` / `#old_token/...` in inline body text and in
/// the frontmatter `tags:` list. Returns `None` if nothing changed.
fn rewrite_tag(source: &str, old_token: &str, new_token: &str) -> Option<String> {
    if old_token.is_empty() {
        return None;
    }

    let after_fm = rewrite_tag_frontmatter(source, old_token, new_token);
    let intermediate = after_fm.as_deref().unwrap_or(source);
    let after_body = rewrite_tag_inline(intermediate, old_token, new_token);

    match after_body {
        Some(body) => Some(body),
        None => after_fm,
    }
}

/// Inline body rewrite: walk `extract_text_runs` (which already
/// excludes frontmatter / fenced & inline code / wiki-link bodies /
/// markdown link targets+URLs) and rewrite `#<tag>` tokens whose tag
/// equals `old_token` or starts with `old_token + "/"`.
///
/// Boundary rules mirror Session D's [`crate::vault::tags::extract_tags`]:
/// start = line-start or preceding char is whitespace; end =
/// `!is_alphanumeric() && != '_' && != '-' && != '/'`. The text-run
/// slices already start fresh after any wiki-link / link / code
/// boundary, so checking `position_in_run == 0 || prev_char is
/// whitespace` is sufficient.
fn rewrite_tag_inline(source: &str, old_token: &str, new_token: &str) -> Option<String> {
    let runs = extract_text_runs(source);
    if runs.is_empty() {
        return None;
    }

    // Build a list of (byte_offset_in_source, byte_len_in_source,
    // replacement_str) edits. Apply at the end as a single pass to
    // avoid quadratic re-allocation.
    let mut edits: Vec<(usize, usize, String)> = Vec::new();

    for run in runs {
        let slice = run.slice;
        let bytes = slice.as_bytes();
        let mut i = 0usize;
        while i < bytes.len() {
            if bytes[i] != b'#' {
                i += 1;
                continue;
            }
            // Start boundary: must be at the very start of the run OR
            // the previous byte is whitespace. `extract_text_runs`
            // already guarantees that the run is plain text — we only
            // need to defend against `email@#tag` style false hits.
            let at_start = i == 0;
            let prev_is_ws = !at_start && {
                let prev = slice[..i].chars().next_back();
                prev.map(char::is_whitespace).unwrap_or(false)
            };
            if !at_start && !prev_is_ws {
                i += 1;
                continue;
            }

            // Scan tag body chars: alphanumeric / `_` / `-` / `/`.
            let tag_start = i + 1;
            let tag_end = scan_tag_body(slice, tag_start);
            if tag_end == tag_start {
                i += 1;
                continue;
            }
            let tag = &slice[tag_start..tag_end];

            let replacement = if tag == old_token {
                Some(format!("#{new_token}"))
            } else {
                tag.strip_prefix(old_token)
                    .and_then(|rest| rest.strip_prefix('/'))
                    .map(|suffix| format!("#{new_token}/{suffix}"))
            };

            if let Some(rep) = replacement {
                let abs_offset = run.start as usize + i;
                let len = tag_end - i; // `#` + tag body
                edits.push((abs_offset, len, rep));
            }
            i = tag_end;
        }
    }

    if edits.is_empty() {
        return None;
    }
    Some(splice_edits(source, &edits))
}

/// Scan forward from `start` while bytes are in the allowed tag
/// charset: alphanumeric / `_` / `-` / `/`. Returns the exclusive end
/// offset of the body (== `start` when nothing matched).
fn scan_tag_body(s: &str, start: usize) -> usize {
    let mut i = start;
    let bytes = s.as_bytes();
    while i < bytes.len() {
        // Walk char-by-char so multi-byte unicode tag chars are
        // handled correctly.
        let rest = &s[i..];
        let Some(c) = rest.chars().next() else { break };
        if c.is_alphanumeric() || c == '_' || c == '-' || c == '/' {
            i += c.len_utf8();
        } else {
            break;
        }
    }
    i
}

/// Apply pre-computed `(offset, byte_len, replacement)` edits to
/// `source` in a single sequential pass. Edits MUST be in ascending
/// offset order and non-overlapping; that's a function-local invariant
/// the caller honours.
fn splice_edits(source: &str, edits: &[(usize, usize, String)]) -> String {
    let mut out = String::with_capacity(source.len());
    let mut cursor = 0usize;
    for (off, len, rep) in edits {
        if *off > cursor {
            out.push_str(&source[cursor..*off]);
        }
        out.push_str(rep);
        cursor = *off + *len;
    }
    if cursor < source.len() {
        out.push_str(&source[cursor..]);
    }
    out
}

/// Frontmatter `tags:` list rewrite. Operates on the raw frontmatter
/// block text rather than reparsing + re-emitting YAML — preserves
/// user formatting (key order, quoting, comments) and only mutates the
/// matching list entries.
///
/// Strategy: locate the `tags:` (or `Tags:`) line within the block;
/// gather either the inline `[…]` value or the subsequent block-list
/// `- entry` lines; rewrite each entry textually if its quoted/bare
/// scalar equals `old_token` or starts with `old_token + "/"`. Returns
/// `None` if no entry matched.
fn rewrite_tag_frontmatter(source: &str, old_token: &str, new_token: &str) -> Option<String> {
    let (fm_body_start, fm_body_end) = locate_frontmatter_body(source)?;
    let block = &source[fm_body_start..fm_body_end];

    let mut edits: Vec<(usize, usize, String)> = Vec::new();

    let mut byte_pos = fm_body_start;
    // We iterate by line indices in the block, but we need absolute
    // source offsets for edits. Walk via line iterator + tracking.
    let mut lines_iter = block.split_inclusive('\n').peekable();
    while let Some(line) = lines_iter.next() {
        // Identify a `tags:` key. Accept any indentation level of 0
        // (frontmatter keys live at the top level in practice; nested
        // mappings could hold a `tags:` too, but that's out of scope).
        let trimmed_no_eol = line.trim_end_matches(['\n', '\r']);
        let line_no_indent = trimmed_no_eol.trim_start();
        // Reject indented continuations — top-level keys only.
        let indent_len = trimmed_no_eol.len() - line_no_indent.len();
        let is_top_level = indent_len == 0;
        let lower = line_no_indent.to_ascii_lowercase();
        if is_top_level && (lower.starts_with("tags:") || lower.starts_with("tags :")) {
            // Strip the key prefix to inspect the value.
            let after_colon_rel = line_no_indent
                .find(':')
                .map(|c| c + 1)
                .unwrap_or(line_no_indent.len());
            let value_part = &line_no_indent[after_colon_rel..];
            let value_part_trim = value_part.trim_start();

            // Case 1: inline flow list `[a, b, c]`.
            if value_part_trim.starts_with('[') {
                // Rewrite each comma-separated entry inside the
                // brackets. Find the brackets' absolute offsets.
                let key_start_in_line = indent_len + after_colon_rel;
                let bracket_open_rel = line[key_start_in_line..]
                    .find('[')
                    .map(|p| key_start_in_line + p);
                let bracket_close_rel = line.rfind(']');
                if let (Some(open), Some(close)) = (bracket_open_rel, bracket_close_rel) {
                    if close > open {
                        let inner = &line[open + 1..close];
                        let inner_abs_start = byte_pos + open + 1;
                        rewrite_inline_entries(
                            inner,
                            inner_abs_start,
                            old_token,
                            new_token,
                            &mut edits,
                        );
                    }
                }
            } else if value_part_trim.is_empty() {
                // Case 2: block list — subsequent lines like `  - foo`.
                // Walk ahead, peeking, until we hit a non-list line.
                let mut next_pos = byte_pos + line.len();
                while let Some(peek) = lines_iter.peek() {
                    let peek_trim = peek.trim_end_matches(['\n', '\r']);
                    let stripped = peek_trim.trim_start();
                    if stripped.starts_with('-') {
                        // Process this list line. Find the `-` then
                        // the entry text after it.
                        let dash_rel = peek_trim.find('-').unwrap();
                        let after_dash = &peek_trim[dash_rel + 1..];
                        let entry_text = after_dash.trim_start();
                        let entry_offset_in_line = peek_trim.len() - entry_text.len();
                        let entry_abs = next_pos + entry_offset_in_line;
                        if let Some((rel_start, rel_len, rep)) =
                            match_tag_entry(entry_text, old_token, new_token)
                        {
                            edits.push((entry_abs + rel_start, rel_len, rep));
                        }
                        next_pos += peek.len();
                        lines_iter.next();
                    } else if stripped.is_empty() {
                        // Blank line inside the list is allowed; advance.
                        next_pos += peek.len();
                        lines_iter.next();
                    } else {
                        break;
                    }
                }
            } else {
                // Case 3: scalar string like `tags: planning` —
                // single entry. Rewrite if it matches.
                let key_start_in_line = indent_len + after_colon_rel;
                let scalar_offset_in_line = line[key_start_in_line..]
                    .find(|c: char| !c.is_whitespace())
                    .map(|p| key_start_in_line + p);
                if let Some(scalar_off) = scalar_offset_in_line {
                    let trailing_eol_len = line.len() - trimmed_no_eol.len();
                    let scalar_end = line.len() - trailing_eol_len;
                    if scalar_end > scalar_off {
                        let scalar = &line[scalar_off..scalar_end];
                        if let Some((rel_start, rel_len, rep)) =
                            match_tag_entry(scalar, old_token, new_token)
                        {
                            edits.push((byte_pos + scalar_off + rel_start, rel_len, rep));
                        }
                    }
                }
            }
        }
        byte_pos += line.len();
    }

    if edits.is_empty() {
        return None;
    }
    // Sort + ensure non-overlapping (the walker emits in order
    // already, but a sort guards against future shape changes).
    let mut sorted = edits;
    sorted.sort_by_key(|(off, _, _)| *off);
    Some(splice_edits(source, &sorted))
}

/// Locate the byte range of the frontmatter block's *body* (between
/// the opening `---\n` and the closing `---` line). Returns `None`
/// when the source has no frontmatter at byte 0.
fn locate_frontmatter_body(source: &str) -> Option<(usize, usize)> {
    let body_start = if source.starts_with("---\n") {
        4
    } else if source.starts_with("---\r\n") {
        5
    } else {
        return None;
    };
    let bytes = source.as_bytes();
    let len = bytes.len();
    let mut probe = body_start;
    while probe < len {
        let line_start = probe;
        while probe < len && bytes[probe] != b'\n' {
            probe += 1;
        }
        let line = &source[line_start..probe];
        let trimmed = line.trim_end_matches('\r');
        if trimmed == "---" || trimmed == "..." {
            return Some((body_start, line_start));
        }
        if probe < len {
            probe += 1;
        }
    }
    None
}

/// Walk comma-separated entries inside `inner` (the text between
/// `[` and `]` of a YAML flow sequence) and emit edits for entries
/// that match the tag rewrite criteria.
fn rewrite_inline_entries(
    inner: &str,
    inner_abs_start: usize,
    old_token: &str,
    new_token: &str,
    edits: &mut Vec<(usize, usize, String)>,
) {
    let mut start = 0usize;
    for (idx, c) in inner.char_indices() {
        if c == ',' {
            emit_entry_edit(
                inner,
                start,
                idx,
                inner_abs_start,
                old_token,
                new_token,
                edits,
            );
            start = idx + 1;
        }
    }
    // Last entry.
    if start <= inner.len() {
        emit_entry_edit(
            inner,
            start,
            inner.len(),
            inner_abs_start,
            old_token,
            new_token,
            edits,
        );
    }
}

fn emit_entry_edit(
    inner: &str,
    start: usize,
    end: usize,
    inner_abs_start: usize,
    old_token: &str,
    new_token: &str,
    edits: &mut Vec<(usize, usize, String)>,
) {
    let entry = &inner[start..end];
    let leading_ws = entry.len() - entry.trim_start().len();
    let trailing_ws = entry.len() - entry.trim_end().len();
    if leading_ws + trailing_ws >= entry.len() {
        return; // empty entry
    }
    let scalar_start_in_entry = leading_ws;
    let scalar_end_in_entry = entry.len() - trailing_ws;
    let scalar = &entry[scalar_start_in_entry..scalar_end_in_entry];
    if let Some((rel_start, rel_len, rep)) = match_tag_entry(scalar, old_token, new_token) {
        let abs = inner_abs_start + start + scalar_start_in_entry + rel_start;
        edits.push((abs, rel_len, rep));
    }
}

/// Given a frontmatter scalar (possibly quoted, possibly prefixed
/// with `#`), test whether it represents `old_token` (or
/// `old_token + "/" + suffix`) and produce a (rel_start, rel_len,
/// replacement) edit relative to the scalar's start.
///
/// Quote handling is deliberately minimal — we accept `"foo"`,
/// `'foo'`, and bare `foo`. The outer quote chars are preserved (we
/// emit replacement only for the inner text); a leading `#` is
/// preserved too (some authors write `tags: ["#foo"]`).
fn match_tag_entry(
    scalar: &str,
    old_token: &str,
    new_token: &str,
) -> Option<(usize, usize, String)> {
    let trimmed = scalar.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Detect quoted scalar.
    let (inner, inner_offset_in_scalar) =
        if (trimmed.starts_with('"') && trimmed.ends_with('"') && trimmed.len() >= 2)
            || (trimmed.starts_with('\'') && trimmed.ends_with('\'') && trimmed.len() >= 2)
        {
            let quote_char_len = 1; // both quote chars are ASCII
            let inner_str = &trimmed[1..trimmed.len() - 1];
            // Offset of `inner_str` within `scalar`: find where `trimmed`
            // starts, then add the open quote.
            let trim_off = scalar.len() - scalar.trim_start().len();
            (inner_str, trim_off + quote_char_len)
        } else {
            let trim_off = scalar.len() - scalar.trim_start().len();
            (trimmed, trim_off)
        };

    // Strip a leading `#` (preserve in output).
    let (body, body_offset_in_scalar, hash_prefix) = if let Some(rest) = inner.strip_prefix('#') {
        (rest, inner_offset_in_scalar + 1, true)
    } else {
        (inner, inner_offset_in_scalar, false)
    };

    let replacement_body = if body == old_token {
        new_token.to_string()
    } else if let Some(suffix) = body
        .strip_prefix(old_token)
        .and_then(|rest| rest.strip_prefix('/'))
    {
        format!("{new_token}/{suffix}")
    } else {
        return None;
    };

    let _ = hash_prefix; // captured for clarity, no behavioural effect (we splice in place)
    Some((body_offset_in_scalar, body.len(), replacement_body))
}

// ---- Block-ref kind -------------------------------------------------

/// Two-pattern block-ref rewrite. Returns `None` when neither pattern
/// matched.
fn rewrite_block_ref(source: &str, old_token: &str, new_token: &str) -> Option<String> {
    if old_token.is_empty() {
        return None;
    }

    let after_ref = rewrite_block_ref_referrers(source, old_token, new_token);
    let intermediate = after_ref.as_deref().unwrap_or(source);
    let after_def = rewrite_block_ref_defining_line(intermediate, old_token, new_token);

    match after_def {
        Some(d) => Some(d),
        None => after_ref,
    }
}

/// Pattern 1: rewrite `[[X#^old]]` referrers via `scan_wikilinks`.
fn rewrite_block_ref_referrers(source: &str, old_token: &str, new_token: &str) -> Option<String> {
    let runs = scan_wikilinks(source);
    let mut hits = 0usize;
    for run in &runs {
        if let TokenizedRun::WikiLink {
            anchor: Some(Anchor::Block { value }),
            ..
        } = run
        {
            if value == old_token {
                hits += 1;
            }
        }
    }
    if hits == 0 {
        return None;
    }

    let mut out = String::with_capacity(source.len());
    for run in runs {
        match run {
            TokenizedRun::Text(t) => out.push_str(&t),
            TokenizedRun::WikiLink {
                target,
                display,
                anchor,
                embed,
            } => {
                let new_anchor = match anchor {
                    Some(Anchor::Block { value }) if value == old_token => Some(Anchor::Block {
                        value: new_token.to_string(),
                    }),
                    other => other,
                };
                emit_wikilink(&mut out, &target, &display, &new_anchor, embed);
            }
            TokenizedRun::PropertyRef { note, property } => {
                // Property refs carry no anchor — pass through unchanged.
                emit_property_ref(&mut out, &note, &property);
            }
        }
    }
    Some(out)
}

/// Pattern 2: rewrite trailing-token `^old` on a defining line. The
/// trailing token is computed as the whitespace-delimited final word
/// of the line (after stripping trailing whitespace + EOL). The block
/// id charset is restricted to the allowed Session G charset (Unicode
/// letters / digits / `_` / `-`).
fn rewrite_block_ref_defining_line(
    source: &str,
    old_token: &str,
    new_token: &str,
) -> Option<String> {
    if !is_allowed_block_id(old_token) {
        return None;
    }
    let mut out = String::with_capacity(source.len());
    let mut changed = false;
    let mut cursor = 0usize;
    for (line, eol_len) in iter_lines_with_eol(source) {
        let line_text = &source[cursor..cursor + line];
        let eol_str = &source[cursor + line..cursor + line + eol_len];

        // Strip trailing whitespace to find the final token.
        let trimmed_end = line_text.trim_end();
        let trailing_ws_len = line_text.len() - trimmed_end.len();

        // Locate the start of the trailing token: walk backward to
        // the previous whitespace char (or start of line).
        let last_ws_byte = trimmed_end
            .char_indices()
            .rfind(|(_, c)| c.is_whitespace())
            .map(|(b, c)| b + c.len_utf8());
        let token_start = last_ws_byte.unwrap_or(0);
        let token = &trimmed_end[token_start..];

        // Token must be exactly `^old_token`.
        let matches = token
            .strip_prefix('^')
            .map(|body| body == old_token)
            .unwrap_or(false);

        if matches {
            // Emit `line[..token_start]`, then `^new_token`, then
            // trailing whitespace + EOL preserved verbatim.
            out.push_str(&line_text[..token_start]);
            out.push('^');
            out.push_str(new_token);
            // Trailing whitespace before EOL (e.g. trailing spaces) —
            // preserve.
            out.push_str(&line_text[trimmed_end.len()..line_text.len()]);
            let _ = trailing_ws_len; // captured for documentation
            out.push_str(eol_str);
            changed = true;
        } else {
            out.push_str(line_text);
            out.push_str(eol_str);
        }
        cursor += line + eol_len;
    }
    if changed {
        Some(out)
    } else {
        None
    }
}

/// Block-id charset: Unicode letters/digits + `_` + `-`. Empty rejected.
fn is_allowed_block_id(s: &str) -> bool {
    if s.is_empty() {
        return false;
    }
    s.chars()
        .all(|c| c.is_alphanumeric() || c == '_' || c == '-')
}

/// Iterate `(line_byte_len, eol_byte_len)` pairs across `source`.
/// `line_byte_len` is the length of the line content including a
/// possible trailing `\r`; `eol_byte_len` is `1` (`\n`) or `0` at EOF
/// without EOL. The caller treats a trailing `\r` as part of the
/// line's content and rewrites the EOL byte verbatim.
fn iter_lines_with_eol(source: &str) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let bytes = source.as_bytes();
    let len = bytes.len();
    let mut i = 0usize;
    while i < len {
        let start = i;
        while i < len && bytes[i] != b'\n' {
            i += 1;
        }
        let line_content_len = i - start;
        let eol_len = if i < len { 1 } else { 0 };
        out.push((line_content_len, eol_len));
        if i < len {
            i += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use cubical_index::{open_index, NewPendingRewrite};
    use tempfile::TempDir;

    fn row(kind: RewriteKind, old: &str, new: &str) -> PendingRewriteRow {
        PendingRewriteRow {
            id: 0,
            target_file: "irrelevant.md".into(),
            rewrite_kind: kind,
            old_token: old.into(),
            new_token: new.into(),
            created_at: 0,
            rename_op_id: 0,
        }
    }

    // ---- Wiki-link kind ------------------------------------------

    #[test]
    fn wikilink_bare_rewrite() {
        let src = "See [[Daily]] for context.\n";
        let out = apply_pending(src, &[row(RewriteKind::WikiLink, "Daily", "Journal")]);
        assert_eq!(out, "See [[Journal]] for context.\n");
    }

    #[test]
    fn property_ref_note_follows_rename() {
        // Renaming a note must also update property refs pointing at it,
        // while self-refs and untouched property names pass through.
        let src = "Age [[Gandalf.age]], self [[.level]], other [[Frodo.hp]].\n";
        let out = apply_pending(src, &[row(RewriteKind::WikiLink, "Gandalf", "Mithrandir")]);
        assert_eq!(
            out,
            "Age [[Mithrandir.age]], self [[.level]], other [[Frodo.hp]].\n"
        );
    }

    #[test]
    fn wikilink_rewrite_follows_dotted_filename_property_ref() {
        // `[[Report v1.2]]` tokenizes as a property-ref but names a file;
        // renaming that file rewrites the whole token to a plain wiki-link
        // with the new name.
        let src = "see [[Report v1.2]] here\n";
        let out = apply_pending(
            src,
            &[row(RewriteKind::WikiLink, "Report v1.2", "Report v3")],
        );
        assert_eq!(out, "see [[Report v3]] here\n");
    }

    #[test]
    fn wikilink_with_display_preserved() {
        let src = "[[Daily|today]] entry\n";
        let out = apply_pending(src, &[row(RewriteKind::WikiLink, "Daily", "Journal")]);
        assert_eq!(out, "[[Journal|today]] entry\n");
    }

    #[test]
    fn wikilink_with_heading_anchor_preserved() {
        let src = "see [[Daily#Heading]] there\n";
        let out = apply_pending(src, &[row(RewriteKind::WikiLink, "Daily", "Journal")]);
        assert_eq!(out, "see [[Journal#Heading]] there\n");
    }

    #[test]
    fn wikilink_with_block_anchor_preserved() {
        let src = "see [[Daily#^abc]] there\n";
        let out = apply_pending(src, &[row(RewriteKind::WikiLink, "Daily", "Journal")]);
        assert_eq!(out, "see [[Journal#^abc]] there\n");
    }

    #[test]
    fn wikilink_embed_flag_preserved() {
        let src = "Embed: ![[Daily]] inline.\n";
        let out = apply_pending(src, &[row(RewriteKind::WikiLink, "Daily", "Journal")]);
        assert_eq!(out, "Embed: ![[Journal]] inline.\n");
    }

    #[test]
    fn wikilink_multiple_in_one_line() {
        let src = "first [[Daily]] then [[Daily]] again\n";
        let out = apply_pending(src, &[row(RewriteKind::WikiLink, "Daily", "Journal")]);
        assert_eq!(out, "first [[Journal]] then [[Journal]] again\n");
    }

    #[test]
    fn wikilink_target_is_full_field_not_prefix() {
        let src = "see [[DailyOther]] and [[Daily]] both\n";
        let out = apply_pending(src, &[row(RewriteKind::WikiLink, "Daily", "Journal")]);
        // Only the exact match flips; DailyOther stays.
        assert_eq!(out, "see [[DailyOther]] and [[Journal]] both\n");
    }

    #[test]
    fn wikilink_noop_returns_input_unchanged() {
        let src = "no wiki-link here\n";
        let out = apply_pending(src, &[row(RewriteKind::WikiLink, "Daily", "Journal")]);
        assert_eq!(out, src);
    }

    #[test]
    fn wikilink_with_anchor_and_display() {
        let src = "[[Daily#Heading|nice]]\n";
        let out = apply_pending(src, &[row(RewriteKind::WikiLink, "Daily", "Journal")]);
        assert_eq!(out, "[[Journal#Heading|nice]]\n");
    }

    // ---- Tag kind ------------------------------------------------

    #[test]
    fn tag_inline_exact_match() {
        let src = "see #planning today\n";
        let out = apply_pending(src, &[row(RewriteKind::Tag, "planning", "scheduling")]);
        assert_eq!(out, "see #scheduling today\n");
    }

    #[test]
    fn tag_inline_nested_prefix() {
        let src = "see #work/active stuff\n";
        let out = apply_pending(src, &[row(RewriteKind::Tag, "work", "projects")]);
        assert_eq!(out, "see #projects/active stuff\n");
    }

    #[test]
    fn tag_inline_boundary_rejects_longer_tag() {
        // `#planning2` is a different tag (digits in body); rewriting
        // `planning -> scheduling` must NOT touch it.
        let src = "see #planning2 today\n";
        let out = apply_pending(src, &[row(RewriteKind::Tag, "planning", "scheduling")]);
        assert_eq!(out, src);
    }

    #[test]
    fn tag_inline_boundary_rejects_non_ws_preceding() {
        // `email@#planning` — `#` is not at line-start and the prev
        // char is not whitespace. Session D boundary rules reject.
        let src = "ping email@#planning sender\n";
        let out = apply_pending(src, &[row(RewriteKind::Tag, "planning", "scheduling")]);
        assert_eq!(out, src);
    }

    #[test]
    fn tag_inline_inside_fenced_code_block_excluded() {
        let src = "before\n```\n#planning inside fence\n```\nafter #planning here\n";
        let out = apply_pending(src, &[row(RewriteKind::Tag, "planning", "scheduling")]);
        // Inside the fence: untouched. After the fence: rewritten.
        assert_eq!(
            out,
            "before\n```\n#planning inside fence\n```\nafter #scheduling here\n"
        );
    }

    #[test]
    fn tag_inline_inside_inline_code_excluded() {
        let src = "literal `#planning` here and #planning loose\n";
        let out = apply_pending(src, &[row(RewriteKind::Tag, "planning", "scheduling")]);
        assert_eq!(out, "literal `#planning` here and #scheduling loose\n");
    }

    #[test]
    fn tag_inline_inside_wikilink_excluded() {
        // `[[#planning]]` — the `#planning` lives inside a wiki-link
        // body and is consumed by extract_text_runs's exclusion.
        let src = "see [[#planning]] and #planning loose\n";
        let out = apply_pending(src, &[row(RewriteKind::Tag, "planning", "scheduling")]);
        assert_eq!(out, "see [[#planning]] and #scheduling loose\n");
    }

    #[test]
    fn tag_frontmatter_flow_list_exact_match() {
        let src = "---\ntags: [planning, work]\n---\nbody\n";
        let out = apply_pending(src, &[row(RewriteKind::Tag, "planning", "scheduling")]);
        assert_eq!(out, "---\ntags: [scheduling, work]\n---\nbody\n");
    }

    #[test]
    fn tag_frontmatter_flow_list_nested_prefix() {
        let src = "---\ntags: [work/active]\n---\nbody\n";
        let out = apply_pending(src, &[row(RewriteKind::Tag, "work", "projects")]);
        assert_eq!(out, "---\ntags: [projects/active]\n---\nbody\n");
    }

    #[test]
    fn tag_frontmatter_preserves_other_keys() {
        let src = "---\ntitle: Hello\ntags: [planning]\nother: kept\n---\nbody\n";
        let out = apply_pending(src, &[row(RewriteKind::Tag, "planning", "scheduling")]);
        assert_eq!(
            out,
            "---\ntitle: Hello\ntags: [scheduling]\nother: kept\n---\nbody\n"
        );
    }

    #[test]
    fn tag_frontmatter_block_list() {
        let src = "---\ntags:\n  - planning\n  - work\n---\nbody\n";
        let out = apply_pending(src, &[row(RewriteKind::Tag, "planning", "scheduling")]);
        assert_eq!(out, "---\ntags:\n  - scheduling\n  - work\n---\nbody\n");
    }

    #[test]
    fn tag_frontmatter_quoted_entry() {
        let src = "---\ntags: [\"#planning\", work]\n---\nbody\n";
        let out = apply_pending(src, &[row(RewriteKind::Tag, "planning", "scheduling")]);
        // Quoting + leading `#` preserved.
        assert_eq!(out, "---\ntags: [\"#scheduling\", work]\n---\nbody\n");
    }

    // ---- BlockRef kind -------------------------------------------

    #[test]
    fn blockref_referrer_bare() {
        let src = "look at [[note#^old]] for ref\n";
        let out = apply_pending(src, &[row(RewriteKind::BlockRef, "old", "new")]);
        assert_eq!(out, "look at [[note#^new]] for ref\n");
    }

    #[test]
    fn blockref_referrer_with_display() {
        let src = "look at [[note#^old|the intro]] there\n";
        let out = apply_pending(src, &[row(RewriteKind::BlockRef, "old", "new")]);
        assert_eq!(out, "look at [[note#^new|the intro]] there\n");
    }

    #[test]
    fn blockref_defining_line_rewrites_trailing_token() {
        let src = "this is the body ^old\nnext line\n";
        let out = apply_pending(src, &[row(RewriteKind::BlockRef, "old", "new")]);
        assert_eq!(out, "this is the body ^new\nnext line\n");
    }

    #[test]
    fn blockref_defining_line_skips_when_trailing_token_has_extra_text() {
        // The trailing token is `extra`, not `^oldid`. No rewrite.
        let src = "body ^oldid extra\n";
        let out = apply_pending(src, &[row(RewriteKind::BlockRef, "oldid", "newid")]);
        assert_eq!(out, src);
    }

    #[test]
    fn blockref_defining_line_unicode_letter_id() {
        let src = "body ^café\n";
        let out = apply_pending(src, &[row(RewriteKind::BlockRef, "café", "renamed")]);
        assert_eq!(out, "body ^renamed\n");
    }

    #[test]
    fn blockref_defining_line_does_not_match_inside_referrer() {
        // `[[note#^old]]` — the referrer pattern handles this. The
        // defining-line check should NOT fire because the trailing
        // token of that line is `[[note#^old]]`, not `^old`.
        let src = "see [[note#^old]]\n";
        let out = apply_pending(src, &[row(RewriteKind::BlockRef, "old", "new")]);
        // Referrer rewrites; the line keeps its `[[...]]` shape.
        assert_eq!(out, "see [[note#^new]]\n");
    }

    #[test]
    fn blockref_referrer_only_matches_exact_id() {
        let src = "[[note#^oldnew]] should not match\n";
        let out = apply_pending(src, &[row(RewriteKind::BlockRef, "old", "new")]);
        assert_eq!(out, src);
    }

    // ---- Composition ---------------------------------------------

    #[test]
    fn composes_tag_then_wikilink_rewrites() {
        let src = "see [[Daily]] and #planning\n";
        let rewrites = vec![
            row(RewriteKind::Tag, "planning", "scheduling"),
            row(RewriteKind::WikiLink, "Daily", "Journal"),
        ];
        let out = apply_pending(src, &rewrites);
        assert_eq!(out, "see [[Journal]] and #scheduling\n");
    }

    #[test]
    fn empty_rewrites_returns_input_unchanged() {
        let src = "anything\n[[Daily]] #planning\n";
        let out = apply_pending(src, &[]);
        assert_eq!(out, src);
    }

    #[test]
    fn multibyte_unicode_source_byte_indexing_correct() {
        // Japanese + emoji + a wikilink. Must not panic; rewrite the
        // wiki-link target.
        let src = "こんにちは 🎉 see [[Daily]] more text\n";
        let out = apply_pending(src, &[row(RewriteKind::WikiLink, "Daily", "Journal")]);
        assert_eq!(out, "こんにちは 🎉 see [[Journal]] more text\n");
    }

    #[test]
    fn multibyte_unicode_tag_rewrite() {
        let src = "🎉 #planning here\n";
        let out = apply_pending(src, &[row(RewriteKind::Tag, "planning", "scheduling")]);
        assert_eq!(out, "🎉 #scheduling here\n");
    }

    // ---- materialize_on_read -------------------------------------

    async fn open_test_index() -> (TempDir, IndexConn) {
        let dir = TempDir::new().expect("tmpdir");
        let conn = open_index(&dir.path().join("index.db"))
            .await
            .expect("open");
        (dir, conn)
    }

    fn new_row(target: &str, kind: RewriteKind, old: &str, new: &str) -> NewPendingRewrite {
        NewPendingRewrite {
            target_file: target.into(),
            rewrite_kind: kind,
            old_token: old.into(),
            new_token: new.into(),
            created_at: 0,
            rename_op_id: 1,
        }
    }

    #[tokio::test]
    async fn materialize_no_pending_returns_input_verbatim() {
        let (_d, conn) = open_test_index().await;
        let src = "see [[Daily]]\n";
        let out = materialize_on_read(&conn, "note.md", src).await.unwrap();
        assert_eq!(out, src);
    }

    #[tokio::test]
    async fn materialize_one_wikilink_row_rewrites_content() {
        let (_d, conn) = open_test_index().await;
        cubical_index::enqueue_pending(
            &conn,
            &[new_row(
                "note.md",
                RewriteKind::WikiLink,
                "Daily",
                "Journal",
            )],
        )
        .await
        .unwrap();

        let src = "see [[Daily]]\n";
        let out = materialize_on_read(&conn, "note.md", src).await.unwrap();
        assert_eq!(out, "see [[Journal]]\n");
    }

    #[tokio::test]
    async fn materialize_filters_rows_by_target_path() {
        let (_d, conn) = open_test_index().await;
        // Row targets a DIFFERENT file — it must not apply here.
        cubical_index::enqueue_pending(
            &conn,
            &[new_row(
                "other.md",
                RewriteKind::WikiLink,
                "Daily",
                "Journal",
            )],
        )
        .await
        .unwrap();

        let src = "see [[Daily]]\n";
        let out = materialize_on_read(&conn, "note.md", src).await.unwrap();
        assert_eq!(out, src);
    }
}
