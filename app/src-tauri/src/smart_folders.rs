//! Smart folders - the Folders tab's second section.
//!
//! One recurring child-folder name, such as `For-AI`, found inside several of
//! the projects already registered in Folders. Applying it restricts this
//! Secret Tunnel endpoint to exactly those child folders and nothing else.
//!
//! Discovery is deliberately small: immediate children of the selected project
//! roots, names only, bounded. No index, no watcher, no new dependency. It is
//! read-only and never changes what is currently exposed - only
//! [`apply`](apply) does, and only for folders the person previewed.

use crate::error::AppError;
use crate::settings::{
    approved_child, fold_folder_name, registered_projects, Settings, SmartFolderMatch, SmartScope,
};
use serde::Serialize;
use std::fs;
use std::path::Path;

/// Immediate children read per project before the listing is called short. A
/// project with more top-level directories than this is reported as incomplete
/// rather than silently half-scanned.
const MAX_ENTRIES_PER_PROJECT: usize = 1000;

/// Distinct names carried back to the window. Beyond this the selector stops
/// being usable anyway, and the scan says so.
const MAX_CANDIDATES: usize = 200;

/// Directories that are never the shared working layer this feature is for.
/// Anything beginning with a dot is excluded separately, which covers `.git`,
/// `.venv`, `.gradle` and the rest without listing them.
const EXCLUDED: [&str; 11] = [
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    "obj",
    "coverage",
    "vendor",
    "__pycache__",
    "venv",
    "site-packages",
];

/// The name this feature offers first when it is present, because it is the one
/// the product was asked for.
const PREFERRED: &str = "for-ai";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartMatchDto {
    pub project: String,
    pub project_name: String,
    pub folder: String,
    pub folder_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartCandidateDto {
    /// The case-folded grouping key. The window sends this back on apply.
    pub key: String,
    /// The real spelling of the first match found, for the selector label.
    pub display: String,
    /// Distinct projects, not directory hits: two same-key directories in one
    /// project still count once.
    pub projects: usize,
    pub matches: Vec<SmartMatchDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartProjectDto {
    pub path: String,
    pub name: String,
    /// Whether the whole listing was read. A project that could not be opened,
    /// or that was cut short at the bound, says so instead of reading as a
    /// complete zero-match scan.
    pub complete: bool,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartScanDto {
    /// Every registered project, whether or not it was scanned this time.
    pub projects: Vec<SmartProjectDto>,
    /// The projects this scan actually covered.
    pub scanned: Vec<String>,
    pub candidates: Vec<SmartCandidateDto>,
    /// True when the candidate list itself was cut short.
    pub truncated: bool,
}

/// Read the immediate child directories of the selected projects and group
/// their names.
///
/// `requested` is the window's draft selection. It is filtered against the
/// registered projects rather than trusted: the frontend chooses which of the
/// person's own folders to look in, never which paths exist.
pub fn scan(settings: &Settings, requested: &[String]) -> SmartScanDto {
    let registered = registered_projects(settings);
    let selected: Vec<String> = if requested.is_empty() {
        registered.clone()
    } else {
        registered
            .iter()
            .filter(|project| {
                requested
                    .iter()
                    .any(|wanted| crate::settings::paths_equal(wanted, project))
            })
            .cloned()
            .collect()
    };

    let mut projects = Vec::new();
    let mut groups: Vec<SmartCandidateDto> = Vec::new();
    let mut truncated = false;

    for project in &registered {
        let name = display_name(project);
        if !selected.iter().any(|chosen| chosen == project) {
            projects.push(SmartProjectDto {
                path: project.clone(),
                name,
                complete: true,
                note: None,
            });
            continue;
        }
        let (children, complete, note) = children_of(project);
        projects.push(SmartProjectDto {
            path: project.clone(),
            name: name.clone(),
            complete,
            note,
        });
        for child in children {
            let key = fold_folder_name(&child);
            if key.is_empty() {
                continue;
            }
            let entry = SmartMatchDto {
                project: project.clone(),
                project_name: name.clone(),
                folder: Path::new(project)
                    .join(&child)
                    .to_string_lossy()
                    .to_string(),
                folder_name: child,
            };
            match groups.iter_mut().find(|group| group.key == key) {
                Some(group) => {
                    // Projects, not hits. Two directories in one project that
                    // fold to the same key are both shown, and counted once.
                    if !group
                        .matches
                        .iter()
                        .any(|existing| existing.project == entry.project)
                    {
                        group.projects += 1;
                    }
                    group.matches.push(entry);
                }
                None => {
                    if groups.len() >= MAX_CANDIDATES {
                        truncated = true;
                        continue;
                    }
                    groups.push(SmartCandidateDto {
                        key,
                        display: entry.folder_name.clone(),
                        projects: 1,
                        matches: vec![entry],
                    });
                }
            }
        }
    }

    // Widest coverage first, with the requested name ahead of everything when
    // it is there at all, and a stable alphabetical tie-break.
    groups.sort_by(|left, right| {
        (right.key == PREFERRED)
            .cmp(&(left.key == PREFERRED))
            .then(right.projects.cmp(&left.projects))
            .then(left.key.cmp(&right.key))
    });

    SmartScanDto {
        projects,
        scanned: selected,
        candidates: groups,
        truncated,
    }
}

/// Turn one previewed selection into a scope, re-proving every folder.
///
/// The window sends exact paths it showed the person. Each is validated here
/// against the registered projects, so neither a hand-made call nor a stale
/// preview can admit a path the backend would not have offered.
pub fn resolve(
    settings: &Settings,
    name: &str,
    folders: &[String],
) -> Result<SmartScope, AppError> {
    let key = fold_folder_name(name);
    if key.is_empty() {
        return Err(AppError::new(
            "smart_scope_name",
            "Choose a folder name first.",
        ));
    }
    let projects = registered_projects(settings);
    let mut matches: Vec<SmartFolderMatch> = Vec::new();
    for folder in folders {
        let parent = Path::new(folder)
            .parent()
            .map(|parent| parent.to_string_lossy().to_string())
            .unwrap_or_default();
        let Some(project) = projects
            .iter()
            .find(|project| crate::settings::paths_equal(project, &parent))
        else {
            return Err(AppError::new(
                "smart_folder_rejected",
                "Only an immediate child of a registered project can be approved.",
            ));
        };
        let approved = approved_child(project, folder, &key)?;
        if matches
            .iter()
            .any(|existing| crate::settings::paths_equal(&existing.folder, &approved))
        {
            continue;
        }
        matches.push(SmartFolderMatch {
            project: project.clone(),
            folder: approved,
        });
    }
    if matches.is_empty() {
        return Err(AppError::new(
            "smart_scope_empty",
            "Select at least one matching folder before applying a scope.",
        ));
    }
    Ok(SmartScope {
        name: name.trim().to_string(),
        matches,
    })
}

/// Whether this installation is currently restricted to smart folders.
pub fn is_active(settings: &Settings) -> bool {
    settings.smart_scope.is_some()
}

/// Refuse a capability that cannot be confined to the approved subfolders.
///
/// Git discovers the repository above whatever directory it is run in, and the
/// GitHub routes act on the whole bound repository, so neither can be narrowed
/// to a child folder by pointing it at one. This slice disables them instead of
/// inventing selective publication, and it refuses at execution rather than by
/// hiding a control: a caller holding an older tool list gets this error too.
pub fn guard_broad_capability(settings: &Settings) -> Result<(), AppError> {
    if is_active(settings) {
        return Err(AppError::new(
            "smart_scope_restricted",
            "Smart folders restricts this endpoint to the approved folders. Repository-wide Git, GitHub and task operations are unavailable until full-project access is restored.",
        ));
    }
    Ok(())
}

/// Immediate child directories worth offering, plus whether the listing was
/// read in full.
fn children_of(project: &str) -> (Vec<String>, bool, Option<String>) {
    let Ok(entries) = fs::read_dir(project) else {
        return (
            Vec::new(),
            false,
            Some("This project could not be read.".to_string()),
        );
    };
    let mut names = Vec::new();
    let mut seen = 0usize;
    for entry in entries.flatten() {
        seen += 1;
        if seen > MAX_ENTRIES_PER_PROJECT {
            return (
                names,
                false,
                Some("Only the first 1000 entries were read.".to_string()),
            );
        }
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if name.starts_with('.') || EXCLUDED.contains(&name.to_lowercase().as_str()) {
            continue;
        }
        // A link is not a folder this endpoint can be confined to: it resolves
        // wherever it points, which may be anywhere. Rejected at discovery so
        // it is never previewed, and rejected again at apply and at every
        // start, because a directory can become one later.
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_symlink() || !kind.is_dir() {
            continue;
        }
        let candidate = Path::new(project).join(&name);
        let resolved = fs::canonicalize(&candidate)
            .map(|path| crate::settings::normalize_windows_verbatim_prefix(&path.to_string_lossy()))
            .unwrap_or_default();
        if !crate::settings::paths_equal(&resolved, &candidate.to_string_lossy()) {
            continue;
        }
        names.push(name);
    }
    (names, true, None)
}

fn display_name(root: &str) -> String {
    Path::new(root)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(root)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::effective_roots;
    use std::env;

    fn fixture(name: &str) -> std::path::PathBuf {
        let root = env::temp_dir().join(format!(
            "secret-tunnel-smart-test-{}-{}",
            std::process::id(),
            name
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn project(root: &Path, name: &str, children: &[&str]) -> String {
        let project = root.join(name);
        fs::create_dir_all(&project).unwrap();
        for child in children {
            fs::create_dir_all(project.join(child)).unwrap();
        }
        crate::settings::normalize_windows_verbatim_prefix(
            &fs::canonicalize(&project).unwrap().to_string_lossy(),
        )
    }

    fn settings_for(projects: &[String]) -> Settings {
        let mut settings = Settings::default();
        settings.access_mode = crate::settings::AccessMode::ReadWrite;
        settings.workspace_path = projects.first().cloned();
        settings.extra_folders = projects[1..].to_vec();
        settings
    }

    #[test]
    fn groups_case_variants_and_counts_projects() {
        let root = fixture("group");
        let a = project(&root, "alpha", &["For-AI", "src"]);
        let b = project(&root, "beta", &["for-ai"]);
        let c = project(&root, "gamma", &["FOR-AI", "For-AI-backup"]);
        let d = project(&root, "delta", &["docs"]);
        let settings = settings_for(&[a, b, c, d]);

        let scan = scan(&settings, &[]);
        let candidate = scan
            .candidates
            .iter()
            .find(|entry| entry.key == "for-ai")
            .expect("for-ai must be a candidate");
        assert_eq!(candidate.projects, 3);
        assert_eq!(candidate.matches.len(), 3);
        // Near misses are different names, not fuzzy matches of this one.
        assert!(scan.candidates.iter().any(|e| e.key == "for-ai-backup"));
        assert!(scan.candidates.iter().all(|e| e.key != "forai"));
        // The requested name leads even though other names exist.
        assert_eq!(scan.candidates[0].key, "for-ai");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn hidden_and_dependency_directories_are_excluded() {
        let root = fixture("exclude");
        let a = project(&root, "alpha", &[".hidden", "node_modules", "For-AI"]);
        let settings = settings_for(&[a]);
        let keys: Vec<String> = scan(&settings, &[])
            .candidates
            .iter()
            .map(|entry| entry.key.clone())
            .collect();
        assert_eq!(keys, vec!["for-ai".to_string()]);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn subset_selection_scans_only_the_chosen_projects() {
        let root = fixture("subset");
        let a = project(&root, "alpha", &["For-AI"]);
        let b = project(&root, "beta", &["For-AI"]);
        let settings = settings_for(&[a.clone(), b]);
        let scan = scan(&settings, &[a.clone()]);
        assert_eq!(scan.scanned, vec![a]);
        assert_eq!(scan.candidates[0].projects, 1);
        // Every registered project is still listed, so the window can show what
        // it did not look in.
        assert_eq!(scan.projects.len(), 2);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn unreadable_project_is_reported_not_counted_as_empty() {
        let root = fixture("missing");
        let a = project(&root, "alpha", &["For-AI"]);
        let mut settings = settings_for(&[a.clone()]);
        settings
            .extra_folders
            .push(root.join("gone").to_string_lossy().to_string());
        let scan = scan(&settings, &[]);
        // A folder that does not validate is not registered at all, so it is
        // absent rather than reported as a complete empty project.
        assert_eq!(scan.projects.len(), 1);
        assert!(scan.projects[0].complete);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn resolve_rejects_paths_outside_registered_projects() {
        let root = fixture("outside");
        let a = project(&root, "alpha", &["For-AI"]);
        let outsider = project(&root, "outsider", &["For-AI"]);
        let settings = settings_for(&[a.clone()]);
        let inside = Path::new(&a).join("For-AI").to_string_lossy().to_string();
        let outside = Path::new(&outsider)
            .join("For-AI")
            .to_string_lossy()
            .to_string();
        assert!(resolve(&settings, "For-AI", &[inside.clone()]).is_ok());
        assert!(resolve(&settings, "For-AI", &[outside]).is_err());
        // A deeper path is not an immediate child, whatever it is named.
        let deep = Path::new(&a)
            .join("For-AI")
            .join("For-AI")
            .to_string_lossy()
            .to_string();
        assert!(resolve(&settings, "For-AI", &[deep]).is_err());
        // The name has to be the one being applied.
        assert!(resolve(&settings, "docs", &[inside]).is_err());
        assert!(resolve(&settings, "For-AI", &[]).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn applied_scope_exposes_only_the_approved_subfolders() {
        let root = fixture("apply");
        let a = project(&root, "alpha", &["For-AI", "src"]);
        let b = project(&root, "beta", &["for-ai"]);
        let c = project(&root, "gamma", &["docs"]);
        let mut settings = settings_for(&[a.clone(), b.clone(), c]);
        let folders = vec![
            Path::new(&a).join("For-AI").to_string_lossy().to_string(),
            Path::new(&b).join("for-ai").to_string_lossy().to_string(),
        ];
        settings.smart_scope = Some(resolve(&settings, "For-AI", &folders).unwrap());

        let roots = effective_roots(&settings).unwrap();
        assert_eq!(roots.len(), 2);
        // Neither project root, nor the unmatched project, is exposed.
        assert!(roots.iter().all(|entry| entry.root != a && entry.root != b));
        assert!(roots.iter().all(|entry| entry.repo_id != "workspace"));
        assert!(roots
            .iter()
            .all(|entry| entry.repo_id.starts_with("smart-")));
        assert!(roots
            .iter()
            .any(|entry| entry.display_name == "alpha/For-AI"));
        // Ids follow the path, so they survive a reordered match list.
        let ids: Vec<String> = roots.iter().map(|entry| entry.repo_id.clone()).collect();
        settings.smart_scope.as_mut().unwrap().matches.reverse();
        let mut reversed: Vec<String> = effective_roots(&settings)
            .unwrap()
            .iter()
            .map(|entry| entry.repo_id.clone())
            .collect();
        reversed.reverse();
        assert_eq!(ids, reversed);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn removing_a_project_revokes_its_matches_and_empty_fails_closed() {
        let root = fixture("revoke");
        let a = project(&root, "alpha", &["For-AI"]);
        let b = project(&root, "beta", &["For-AI"]);
        let mut settings = settings_for(&[a.clone(), b.clone()]);
        let folders = vec![
            Path::new(&a).join("For-AI").to_string_lossy().to_string(),
            Path::new(&b).join("For-AI").to_string_lossy().to_string(),
        ];
        settings.smart_scope = Some(resolve(&settings, "For-AI", &folders).unwrap());
        assert_eq!(effective_roots(&settings).unwrap().len(), 2);

        settings.extra_folders.clear();
        assert_eq!(effective_roots(&settings).unwrap().len(), 1);

        // The last match gone is an error, never a fall back to the project.
        fs::remove_dir_all(Path::new(&a).join("For-AI")).unwrap();
        let error = effective_roots(&settings).unwrap_err();
        assert_eq!(error.code, "smart_scope_unavailable");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn adding_a_project_does_not_widen_an_applied_scope() {
        let root = fixture("widen");
        let a = project(&root, "alpha", &["For-AI"]);
        let mut settings = settings_for(&[a.clone()]);
        let folders = vec![Path::new(&a).join("For-AI").to_string_lossy().to_string()];
        settings.smart_scope = Some(resolve(&settings, "For-AI", &folders).unwrap());

        let late = project(&root, "late", &["For-AI"]);
        settings.extra_folders.push(late.clone());
        let roots = effective_roots(&settings).unwrap();
        assert_eq!(roots.len(), 1);
        assert!(roots.iter().all(|entry| !entry.root.starts_with(&late)));
        // The new project is offered by discovery, which changes nothing until
        // the person previews and applies it.
        assert!(scan(&settings, &[])
            .candidates
            .iter()
            .any(|entry| entry.key == "for-ai" && entry.projects == 2));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn invalid_stored_scope_fails_closed() {
        let root = fixture("invalid");
        let a = project(&root, "alpha", &["For-AI"]);
        let mut settings = settings_for(&[a.clone()]);
        settings.smart_scope = Some(SmartScope {
            name: String::new(),
            matches: vec![SmartFolderMatch {
                project: a.clone(),
                folder: Path::new(&a).join("For-AI").to_string_lossy().to_string(),
            }],
        });
        assert!(effective_roots(&settings).is_err());

        // A stored match whose name no longer folds to the scope's is not a
        // match, so the scope is left with nothing and refuses.
        settings.smart_scope = Some(SmartScope {
            name: "For-AI".to_string(),
            matches: vec![SmartFolderMatch {
                project: a.clone(),
                folder: Path::new(&a).join("src").to_string_lossy().to_string(),
            }],
        });
        assert!(effective_roots(&settings).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn legacy_settings_without_the_field_keep_broad_roots() {
        let root = fixture("legacy");
        let a = project(&root, "alpha", &["For-AI"]);
        let stored = format!(
            "{{\"workspacePath\":{},\"accessMode\":\"read_write\"}}",
            serde_json::to_string(&a).unwrap()
        );
        let settings: Settings = serde_json::from_str(&stored).unwrap();
        assert!(settings.smart_scope.is_none());
        let roots = effective_roots(&settings).unwrap();
        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0].repo_id, "workspace");
        assert!(guard_broad_capability(&settings).is_ok());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn scoped_settings_refuse_broad_capabilities() {
        let root = fixture("guard");
        let a = project(&root, "alpha", &["For-AI"]);
        let mut settings = settings_for(&[a.clone()]);
        assert!(guard_broad_capability(&settings).is_ok());
        let folders = vec![Path::new(&a).join("For-AI").to_string_lossy().to_string()];
        settings.smart_scope = Some(resolve(&settings, "For-AI", &folders).unwrap());
        let error = guard_broad_capability(&settings).unwrap_err();
        assert_eq!(error.code, "smart_scope_restricted");
        let _ = fs::remove_dir_all(root);
    }
}
