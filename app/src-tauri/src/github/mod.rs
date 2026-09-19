//! GitHub integration.
//!
//! Implements the architecture in `For-AI/PLANNER/github-sync/PLAN.md`. The
//! feature is disabled by default and is a separate, typed action broker: it
//! does not work by enabling the vendored MCP server's generic Git operations,
//! and it never exposes a way to run an arbitrary command.
//!
//! Current state is recorded in `STATUS.md`. This module is the beta slice:
//! bounded execution, repository inspection, and the plan/approval/apply engine
//! for the core publish workflow. It is not the complete 26-step plan.

// These services are built and tested ahead of the desktop commands and MCP
// tools that will call them, so most items currently have no caller inside the
// crate. That is not the same as dead code, and silencing it here keeps a real
// dead-code warning elsewhere visible. The allow comes off once Step 21 wires
// the tool surface.
#![allow(dead_code)]

pub mod account;
pub mod broker;
pub mod coordinator;
pub mod credential_store;
pub mod exec;
pub mod git;
pub mod operations;
pub mod plan;
pub mod publication;
pub mod snapshot;

#[cfg(test)]
mod broker_tests;

#[cfg(test)]
mod coordinator_tests;

#[cfg(test)]
mod exec_tests;

#[cfg(test)]
mod git_tests;

#[cfg(test)]
mod plan_tests;

#[cfg(test)]
mod hardening_tests;
