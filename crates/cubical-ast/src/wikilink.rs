//! Pure wiki-link tokenizer. Scans an `Inline::Text` value for
//! `[[…]]` / `![[…]]` runs and yields a sequence of `TokenizedRun`s.
//!
//! Grammar in `docs/superpowers/plans/2026-05-23-l3-session-a-wikilink-parsing.md`
//! § "Wiki-link grammar". The grammar is mirrored byte-for-byte in
//! `ui/src/ast/wikilink.ts`; the L1 parity harness extends to wiki-link
//! fixtures so the two stay in lockstep.

use crate::types::Anchor;

/// One run produced by [`scan_wikilinks`].
#[derive(Debug, Clone, PartialEq)]
pub enum TokenizedRun {
    /// Plain text between (or around) wiki-links.
    Text(String),
    /// A successfully parsed wiki-link.
    WikiLink {
        /// Parsed target (trimmed, non-empty).
        target: String,
        /// Optional `|display` text.
        display: Option<String>,
        /// Optional `#heading` or `#^block-id` anchor.
        anchor: Option<Anchor>,
        /// `true` when prefixed `!` (embed).
        embed: bool,
    },
    /// A frontmatter property reference: `[[note.prop]]` (cross-file) or
    /// `[[.prop]]` (self, `note == None`). Top-level key only; the target
    /// is split at the FIRST dot.
    PropertyRef {
        /// Resolved note name, or `None` for a self-reference.
        note: Option<String>,
        /// Property (frontmatter key) name, trimmed, non-empty.
        property: String,
    },
}

/// Scan a text run for `[[…]]` and `![[…]]`. Always returns at least one
/// element when `input` is non-empty (a single `Text` if no wiki-links).
/// An empty `input` returns an empty `Vec`.
pub fn scan_wikilinks(input: &str) -> Vec<TokenizedRun> {
    if input.is_empty() {
        return Vec::new();
    }
    let bytes = input.as_bytes();
    let mut out: Vec<TokenizedRun> = Vec::new();
    let mut cursor: usize = 0;
    let mut i: usize = 0;
    while i < bytes.len() {
        let (open_byte, content_start, is_embed) = match find_open(bytes, i) {
            Some(found) => found,
            None => break,
        };
        let close = match find_close(bytes, content_start) {
            Some(c) => c,
            None => break,
        };
        let body = &input[content_start..close];
        match parse_body(body, is_embed) {
            Some(wl) => {
                if open_byte > cursor {
                    out.push(TokenizedRun::Text(input[cursor..open_byte].to_string()));
                }
                out.push(wl);
                cursor = close + 2;
                i = cursor;
            }
            None => {
                // Unparseable body (empty target); skip the `[[` and keep
                // searching after it. Do not flush — accumulate into the
                // text run that surrounds this section.
                i = content_start;
            }
        }
    }
    if cursor < bytes.len() {
        out.push(TokenizedRun::Text(input[cursor..].to_string()));
    }
    out
}

/// Find the next opening bracket from `start`. Returns
/// `(opener_byte_pos, content_byte_pos, is_embed)`.
fn find_open(bytes: &[u8], start: usize) -> Option<(usize, usize, bool)> {
    let mut i = start;
    while i + 1 < bytes.len() {
        if bytes[i] == b'[' && bytes[i + 1] == b'[' {
            if i > 0 && bytes[i - 1] == b'!' {
                return Some((i - 1, i + 2, true));
            }
            return Some((i, i + 2, false));
        }
        i += 1;
    }
    None
}

/// Find the next `]]` from `start`. Returns the index of the first `]`.
fn find_close(bytes: &[u8], start: usize) -> Option<usize> {
    let mut i = start;
    while i + 1 < bytes.len() {
        if bytes[i] == b']' && bytes[i + 1] == b']' {
            return Some(i);
        }
        i += 1;
    }
    None
}

/// Parse the inner body of `[[BODY]]` into a `WikiLink`. Returns `None`
/// when the body is empty after trimming.
fn parse_body(body: &str, is_embed: bool) -> Option<TokenizedRun> {
    let (head, display) = match body.find('|') {
        Some(pipe) => (&body[..pipe], Some(body[pipe + 1..].trim().to_string())),
        None => (body, None),
    };
    let (target_raw, anchor) = match head.find('#') {
        Some(hash) => {
            let target = &head[..hash];
            let rest = &head[hash + 1..];
            let anchor = if let Some(block) = rest.strip_prefix('^') {
                let v = block.trim();
                if v.is_empty() {
                    None
                } else {
                    Some(Anchor::Block {
                        value: v.to_string(),
                    })
                }
            } else {
                let v = rest.trim();
                if v.is_empty() {
                    None
                } else {
                    Some(Anchor::Heading {
                        value: v.to_string(),
                    })
                }
            };
            (target, anchor)
        }
        None => (head, None),
    };
    let target = target_raw.trim();
    if target.is_empty() {
        return None;
    }
    // Property-ref branch: a dotted target with no anchor is a frontmatter
    // reference, not a navigational link. Split at the FIRST dot.
    if anchor.is_none() {
        if let Some(dot) = target.find('.') {
            let note_raw = target[..dot].trim();
            let property = target[dot + 1..].trim();
            if property.is_empty() {
                return None;
            }
            return Some(TokenizedRun::PropertyRef {
                note: if note_raw.is_empty() {
                    None
                } else {
                    Some(note_raw.to_string())
                },
                property: property.to_string(),
            });
        }
    }
    Some(TokenizedRun::WikiLink {
        target: target.to_string(),
        display,
        anchor,
        embed: is_embed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wl(target: &str) -> TokenizedRun {
        TokenizedRun::WikiLink {
            target: target.into(),
            display: None,
            anchor: None,
            embed: false,
        }
    }

    fn text(s: &str) -> TokenizedRun {
        TokenizedRun::Text(s.into())
    }

    fn pref(note: Option<&str>, property: &str) -> TokenizedRun {
        TokenizedRun::PropertyRef {
            note: note.map(|s| s.to_string()),
            property: property.to_string(),
        }
    }

    #[test]
    fn cross_file_property_ref() {
        assert_eq!(
            scan_wikilinks("[[Gandalf.age]]"),
            vec![pref(Some("Gandalf"), "age")]
        );
    }

    #[test]
    fn self_property_ref() {
        assert_eq!(scan_wikilinks("[[.age]]"), vec![pref(None, "age")]);
    }

    #[test]
    fn property_ref_splits_on_first_dot_only() {
        // Top-level only: remainder kept verbatim, won't resolve later.
        assert_eq!(scan_wikilinks("[[a.b.c]]"), vec![pref(Some("a"), "b.c")]);
    }

    #[test]
    fn empty_property_falls_back_to_text() {
        assert_eq!(scan_wikilinks("[[Gandalf.]]"), vec![text("[[Gandalf.]]")]);
        assert_eq!(scan_wikilinks("[[.]]"), vec![text("[[.]]")]);
    }

    #[test]
    fn dotted_target_with_anchor_stays_wikilink() {
        // Anchor present → not a property ref (broken link later; acceptable).
        assert!(matches!(
            scan_wikilinks("[[Gandalf.age#h]]").as_slice(),
            [TokenizedRun::WikiLink { .. }]
        ));
    }

    #[test]
    fn plain_text_passes_through() {
        assert_eq!(scan_wikilinks("just text"), vec![text("just text")]);
    }

    #[test]
    fn empty_input_returns_empty_vec() {
        assert_eq!(scan_wikilinks(""), Vec::<TokenizedRun>::new());
    }

    #[test]
    fn simple_wikilink() {
        assert_eq!(scan_wikilinks("[[note]]"), vec![wl("note")]);
    }

    #[test]
    fn wikilink_with_display() {
        assert_eq!(
            scan_wikilinks("[[note|see here]]"),
            vec![TokenizedRun::WikiLink {
                target: "note".into(),
                display: Some("see here".into()),
                anchor: None,
                embed: false,
            }]
        );
    }

    #[test]
    fn wikilink_with_heading_anchor() {
        assert_eq!(
            scan_wikilinks("[[note#heading]]"),
            vec![TokenizedRun::WikiLink {
                target: "note".into(),
                display: None,
                anchor: Some(Anchor::Heading {
                    value: "heading".into()
                }),
                embed: false,
            }]
        );
    }

    #[test]
    fn wikilink_with_block_anchor() {
        assert_eq!(
            scan_wikilinks("[[note#^intro]]"),
            vec![TokenizedRun::WikiLink {
                target: "note".into(),
                display: None,
                anchor: Some(Anchor::Block {
                    value: "intro".into()
                }),
                embed: false,
            }]
        );
    }

    #[test]
    fn wikilink_anchor_then_display() {
        assert_eq!(
            scan_wikilinks("[[note#heading|nice text]]"),
            vec![TokenizedRun::WikiLink {
                target: "note".into(),
                display: Some("nice text".into()),
                anchor: Some(Anchor::Heading {
                    value: "heading".into()
                }),
                embed: false,
            }]
        );
    }

    #[test]
    fn embed_wikilink() {
        assert_eq!(
            scan_wikilinks("![[diagram]]"),
            vec![TokenizedRun::WikiLink {
                target: "diagram".into(),
                display: None,
                anchor: None,
                embed: true,
            }]
        );
    }

    #[test]
    fn text_around_wikilink() {
        assert_eq!(
            scan_wikilinks("see [[note]] for context"),
            vec![text("see "), wl("note"), text(" for context")]
        );
    }

    #[test]
    fn multiple_wikilinks() {
        assert_eq!(
            scan_wikilinks("[[a]] and [[b]]"),
            vec![wl("a"), text(" and "), wl("b")]
        );
    }

    #[test]
    fn unclosed_brackets_pass_through_as_text() {
        assert_eq!(
            scan_wikilinks("text [[unclosed and more"),
            vec![text("text [[unclosed and more")]
        );
    }

    #[test]
    fn empty_target_is_rejected() {
        assert_eq!(scan_wikilinks("[[]] noise"), vec![text("[[]] noise")]);
    }

    #[test]
    fn whitespace_only_target_is_rejected() {
        assert_eq!(scan_wikilinks("[[   ]]"), vec![text("[[   ]]")]);
    }

    #[test]
    fn whitespace_inside_target_is_preserved_and_trimmed_at_edges() {
        assert_eq!(scan_wikilinks("[[ a note ]]"), vec![wl("a note")]);
    }

    #[test]
    fn hash_after_pipe_is_part_of_display_not_anchor() {
        assert_eq!(
            scan_wikilinks("[[note|see #3]]"),
            vec![TokenizedRun::WikiLink {
                target: "note".into(),
                display: Some("see #3".into()),
                anchor: None,
                embed: false,
            }]
        );
    }
}
