//! This crate provides Mojo language support for the [tree-sitter] parsing library.
//!
//! [tree-sitter]: https://tree-sitter.github.io/

use tree_sitter_language::LanguageFn;

extern "C" {
    fn tree_sitter_mojo() -> *const ();
}

/// The tree-sitter [`LanguageFn`] for this grammar.
pub const LANGUAGE: LanguageFn = unsafe { LanguageFn::from_raw(tree_sitter_mojo) };

/// The tagging query for this grammar: what counts as a definition, for an
/// outline and for stepping between them.
pub const TAGS_QUERY: &str = include_str!("../../queries/tags.scm");

/// The content of the [`node-types.json`][] file for this grammar.
///
/// [`node-types.json`]: https://tree-sitter.github.io/tree-sitter/using-parsers/6-static-node-types
pub const NODE_TYPES: &str = include_str!("../../src/node-types.json");

#[cfg(test)]
mod tests {
    #[test]
    fn the_tags_query_compiles_and_finds_the_definitions() {
        let language: tree_sitter::Language = super::LANGUAGE.into();
        let query = tree_sitter::Query::new(&language, super::TAGS_QUERY).expect("tags.scm");
        let mut parser = tree_sitter::Parser::new();
        parser.set_language(&language).unwrap();
        let source = "trait T:\n    fn show(self): ...\n\n@value\nstruct S(T):\n    fn show(self):\n        pass\n\nfn free():\n    pass\n";
        let tree = parser.parse(source, None).unwrap();
        let names: Vec<&str> = query
            .capture_names()
            .iter()
            .copied()
            .collect();
        assert!(names.contains(&"definition.function"), "{names:?}");
        assert!(names.contains(&"definition.class"), "{names:?}");

        let mut cursor = tree_sitter::QueryCursor::new();
        let mut found: Vec<String> = Vec::new();
        let mut matches = cursor.matches(&query, tree.root_node(), source.as_bytes());
        while let Some(one) = streaming_iterator::StreamingIterator::next(&mut matches) {
            for capture in one.captures {
                if query.capture_names()[capture.index as usize] == "name" {
                    found.push(capture.node.utf8_text(source.as_bytes()).unwrap().to_string());
                }
            }
        }
        found.sort();
        assert_eq!(found, ["S", "T", "free", "show", "show"], "每一個定義都捕到了");
    }

    #[test]
    fn the_grammar_loads() {
        let mut parser = tree_sitter::Parser::new();
        parser
            .set_language(&super::LANGUAGE.into())
            .expect("loading the Mojo grammar");
        let tree = parser.parse("fn main():\n    print(\"hello\")\n", None).unwrap();
        assert!(!tree.root_node().has_error(), "a four-line program parses");
    }
}
