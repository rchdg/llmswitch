import type { ApplyResult, Profile, Tool } from "../types.js";
import { applyClaudeProfile, deactivateClaudeProfile } from "./claude.js";
import { applyCodexProfile, deactivateCodexProfile } from "./codex.js";
import { applyOpenCodeProfile, deactivateOpenCodeProfile } from "./opencode.js";
import { assertCompatible } from "../formats/compatibility.js";
import { clearActiveProfile } from "../store/profiles.js";

export async function applyProfile(
  tool: Tool,
  profile: Profile,
): Promise<ApplyResult> {
  assertCompatible(tool, profile.apiFormat);
  switch (tool) {
    case "claude":
      return applyClaudeProfile(profile);
    case "codex":
      return applyCodexProfile(profile);
    case "opencode":
      return applyOpenCodeProfile(profile);
  }
}

/** Disable the currently applied provider and clear tool-side managed config. */
export async function deactivateProfile(
  tool: Tool,
  profileName?: string | null,
): Promise<ApplyResult> {
  let result: ApplyResult;
  switch (tool) {
    case "claude":
      result = await deactivateClaudeProfile();
      break;
    case "codex":
      result = await deactivateCodexProfile(profileName);
      break;
    case "opencode":
      result = deactivateOpenCodeProfile(profileName);
      break;
  }
  clearActiveProfile(tool);
  return result;
}
