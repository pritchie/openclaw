import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { compareSemverStrings } from "../infra/update-check.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { note } from "../terminal/note.js";

// Minimum signal-cli floor for the current OpenClaw Signal feature set.
// Rationale: 0.13.14 is the first post-2025 stabilization point after the
// 0.13.10-0.13.13 server/storage-sync churn, and includes transport/protocol
// changes OpenClaw relies on staying stable under JSON-RPC/SSE usage
// (notably websocket-backed requests and improved decryption-error handling).
// Newer versions are preferred, but doctor uses this as the minimum supported floor.
const MIN_SIGNAL_CLI_VERSION = "0.13.14";

type SignalCliHealthTarget = {
  cliPath: string;
  configKey: string;
};

function classifySignalCliInstall(params: {
  root: string | null;
  cliPath: string;
}): "workspace" | "managed" | "system" {
  const resolvedCliPath = path.resolve(params.cliPath);
  const managedRoots = [
    path.resolve(path.join(process.env.HOME ?? "~", ".openclaw", "tools", "signal-cli")),
    path.resolve(path.join(process.env.HOME ?? "~", ".config", "openclaw", "tools", "signal-cli")),
  ];
  if (
    managedRoots.some(
      (root) => resolvedCliPath === root || resolvedCliPath.startsWith(root + path.sep),
    ) ||
    /(?:^|\/)tools\/signal-cli\/[^/]+\//.test(resolvedCliPath)
  ) {
    return "managed";
  }
  if (params.root) {
    const resolvedRoot = path.resolve(params.root);
    const relative = path.relative(resolvedRoot, resolvedCliPath);
    if (relative !== "" && !relative.startsWith("..")) {
      return "workspace";
    }
  }
  return "system";
}

async function probeSignalCliVersion(cliPath: string): Promise<string | null> {
  try {
    const result = await runCommandWithTimeout([cliPath, "--version"], { timeoutMs: 10_000 });
    if (result.code !== 0) {
      return null;
    }
    const text = result.stdout.trim() || result.stderr.trim();
    const normalized = text.replace(/^signal-cli\s+/, "").trim();
    return normalized || null;
  } catch {
    return null;
  }
}

function listConfiguredSignalCliHealthTargets(cfg: OpenClawConfig): SignalCliHealthTarget[] {
  const targets: SignalCliHealthTarget[] = [];
  const seenPaths = new Set<string>();
  const addTarget = (cliPath: string | undefined, configKey: string) => {
    const trimmed = cliPath?.trim();
    if (!trimmed || seenPaths.has(trimmed)) {
      return;
    }
    seenPaths.add(trimmed);
    targets.push({ cliPath: trimmed, configKey });
  };

  const signalConfig = cfg.channels?.signal;
  addTarget(signalConfig?.cliPath, "channels.signal.cliPath");

  const accountEntries = Object.entries(signalConfig?.accounts ?? {}).toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  for (const [accountId, accountCfg] of accountEntries) {
    addTarget(accountCfg?.cliPath, `channels.signal.accounts.${accountId}.cliPath`);
  }

  return targets;
}

export async function noteSignalCliVersionHealth(
  root: string | null,
  cfg: OpenClawConfig,
): Promise<void> {
  const configuredTargets = listConfiguredSignalCliHealthTargets(cfg);
  if (configuredTargets.length === 0) {
    return;
  }

  for (const configuredTarget of configuredTargets) {
    const installKind = classifySignalCliInstall({ root, cliPath: configuredTarget.cliPath });
    const version = await probeSignalCliVersion(configuredTarget.cliPath);
    if (!version) {
      note(
        [
          `- signal-cli is configured at ${configuredTarget.cliPath} but doctor could not read its version.`,
          `- configured in: ${configuredTarget.configKey}`,
          "- Quick check: <configured signal-cli path> --version",
        ].join("\n"),
        "Install",
      );
      continue;
    }

    const cmp = compareSemverStrings(version, MIN_SIGNAL_CLI_VERSION);
    if (cmp != null && cmp >= 0) {
      continue;
    }

    const fixLines =
      installKind === "workspace"
        ? [
            "- This looks like a workspace-local build, so update/rebuild the local Signal CLI in the repo and verify the configured path again.",
            `- If you do not want workspace drift, point ${configuredTarget.configKey} at a separately installed signal-cli instead.`,
          ]
        : installKind === "managed"
          ? [
              "- This looks like an OpenClaw-managed install, so rerun the Signal CLI install/update flow to refresh it.",
              "- After updating, rerun doctor to verify the version floor.",
            ]
          : [
              `- This looks like a system install, so upgrade signal-cli with your package manager or replace ${configuredTarget.configKey} with a newer binary.`,
              "- After updating, rerun doctor to verify the version floor.",
            ];

    note(
      [
        `- signal-cli ${version} is below the minimum supported version ${MIN_SIGNAL_CLI_VERSION} for the current OpenClaw Signal feature set.`,
        `- configured path: ${configuredTarget.cliPath}`,
        `- configured in: ${configuredTarget.configKey}`,
        ...fixLines,
      ].join("\n"),
      "Install",
    );
  }
}

export function noteSourceInstallIssues(root: string | null) {
  if (!root) {
    return;
  }

  const workspaceMarker = path.join(root, "pnpm-workspace.yaml");
  if (!fs.existsSync(workspaceMarker)) {
    return;
  }

  const warnings: string[] = [];
  const nodeModules = path.join(root, "node_modules");
  const pnpmStore = path.join(nodeModules, ".pnpm");
  const tsxBin = path.join(nodeModules, ".bin", "tsx");
  const srcEntry = path.join(root, "src", "entry.ts");

  if (fs.existsSync(nodeModules) && !fs.existsSync(pnpmStore)) {
    warnings.push(
      "- node_modules was not installed by pnpm (missing node_modules/.pnpm). Run: pnpm install",
    );
  }

  if (fs.existsSync(path.join(root, "package-lock.json"))) {
    warnings.push(
      "- package-lock.json present in a pnpm workspace. If you ran npm install, remove it and reinstall with pnpm.",
    );
  }

  if (fs.existsSync(srcEntry) && !fs.existsSync(tsxBin)) {
    warnings.push("- tsx binary is missing for source runs. Run: pnpm install");
  }

  if (warnings.length > 0) {
    note(warnings.join("\n"), "Install");
  }
}
