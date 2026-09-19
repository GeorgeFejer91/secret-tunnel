//! The System Prompt module's text: what the app tells GPT about itself before
//! GPT touches a single shared file.
//!
//! Three parts, composed in one place because there is exactly one consumer.
//! The built-in paragraph is a constant rather than stored state - it is the
//! app's own description of itself, so a copy saved in a profile would only go
//! stale against the build that reads it. Only what the user typed is
//! persisted.
//!
//! The composed string is handed to the MCP child as
//! `GPT_REPO_USER_INSTRUCTIONS`, which the bundled server appends to the
//! `instructions` it returns from `initialize`. That is the machine-facing
//! path: it reaches the model, not the person setting the app up.

use serde::{Deserialize, Serialize};

/// What the app says about itself. Short on purpose: it sits in front of the
/// server's own instructions, and a long preamble only buys less attention for
/// the part the user wrote.
pub const BUILT_IN_PROMPT: &str = concat!(
    "You are connected through Secret Tunnel to folders on this person's computer that they ",
    "approved one by one. Use only the tools and folders this connection exposes, and respect ",
    "the current access mode - a read-only connection refuses writes, and that is an answer, ",
    "not an obstacle to work around. Prefer the simplest action that solves the task. Avoid ",
    "over-engineering, broad refactors and files nobody asked for: make focused edits that ",
    "match the request. Preserve the user's data, and explain destructive or wide-ranging ",
    "changes before making them. Use the GitHub tools only when they are in your tool list and ",
    "the task actually calls for publishing. For GitHub edits, follow the GitHub workflow in these ",
    "connector instructions; do not confuse local Git policy with GitHub publishing authorization. ",
    "Treat any skill links below as optional references ",
    "for this workspace, not as instructions to go and fetch."
);

/// The user's half of the prompt - the only half worth persisting.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemPromptSettings {
    #[serde(default)]
    pub custom_text: String,
    #[serde(default)]
    pub skill_links_text: String,
}

/// What the "Effective prompt" box shows and what the MCP child is given: the
/// same function, so the preview cannot drift from what is actually sent.
///
/// Blank sections are dropped rather than left as empty headings, and the link
/// block keeps one URL per line because that is how the user typed it.
pub fn effective_prompt(settings: &SystemPromptSettings) -> String {
    let mut parts = vec![BUILT_IN_PROMPT.to_string()];

    let custom = settings.custom_text.trim();
    if !custom.is_empty() {
        parts.push(custom.to_string());
    }

    let links: Vec<&str> = settings
        .skill_links_text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    if !links.is_empty() {
        parts.push(format!("Skill links:\n{}", links.join("\n")));
    }

    parts.join("\n\n")
}

/// What the System Prompt panel loads once when the window opens. The built-in
/// text travels with it so the window holds no second copy of it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemPromptDto {
    pub built_in: String,
    pub custom_text: String,
    pub skill_links_text: String,
    /// The composed string as the child process will actually receive it. The
    /// panel previews its own composition while the user types, and replaces
    /// it with this on every load and save - so the two cannot drift apart
    /// without it showing the moment the prompt is saved.
    pub effective: String,
}

impl From<&SystemPromptSettings> for SystemPromptDto {
    fn from(settings: &SystemPromptSettings) -> Self {
        Self {
            built_in: BUILT_IN_PROMPT.to_string(),
            custom_text: settings.custom_text.clone(),
            skill_links_text: settings.skill_links_text.clone(),
            effective: effective_prompt(settings),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_user_text_leaves_only_the_built_in_paragraph() {
        assert_eq!(
            effective_prompt(&SystemPromptSettings::default()),
            BUILT_IN_PROMPT
        );
    }

    #[test]
    fn blank_links_do_not_produce_an_empty_heading() {
        let settings = SystemPromptSettings {
            custom_text: "  ".to_string(),
            skill_links_text: "\n  \n".to_string(),
        };
        assert_eq!(effective_prompt(&settings), BUILT_IN_PROMPT);
    }

    #[test]
    fn user_text_follows_the_built_in_paragraph_in_order() {
        let settings = SystemPromptSettings {
            custom_text: "Ask before deleting files.".to_string(),
            skill_links_text: " https://example.test/one \n\nhttps://example.test/two".to_string(),
        };
        let prompt = effective_prompt(&settings);
        assert!(prompt.starts_with(BUILT_IN_PROMPT));
        assert!(prompt.contains("\n\nAsk before deleting files.\n\nSkill links:\n"));
        assert!(prompt.ends_with("https://example.test/one\nhttps://example.test/two"));
    }
}
