import fs from "node:fs";
import path from "node:path";
import { resolveMergedAccountConfig } from "../channels/plugins/account-helpers.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SignalAccountConfig } from "../config/types.signal.js";
import { compareSemverStrings } from "../infra/update-check.js";
import { probeSignal } from "../plugin-sdk/signal-surface.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";
import { note } from "../terminal/note.js";

// Minimum signal-cli floor for the current OpenClaw Signal feature set.
// Rationale: 0.13.14 is the first post-2025 stabilization point after the
// 0.13.10-0.13.13 server/storage-sync churn, and includes transport/protocol
// changes OpenClaw relies on staying stable under JSON-RPC/SSE usage
// (notably websocket-backed requests and improved decryption-error handling).
// Newer versions are preferred, but doctor uses this as the minimum supported floor.
const MIN_SIGNAL_CLI_VERSION = "0.13.14";
const SIGNAL_VERSION_PROBE_TIMEOUT_MS = 10_000;

type SignalVersionHealthTarget = {
  accountId: string;
  accountLabel: string;
  baseUrl: string;
  effectiveAutoStart: boolean;
  cliPath: string | null;
  cliSourceLabel: string | null;
};

type SignalDaemonVersionProbe = {
  version: string | null;
  error: string | null;
};

function classifySignalCliInstall(params: {
  root: string | null;
  cliPath: string;
}): "workspace" | "managed" | "system" {
  if (!path.isAbsolute(params.cliPath) && !/[\\/]/.test(params.cliPath)) {
    return "system";
  }
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
    const result = await runCommandWithTimeout([cliPath, "--version"], {
      timeoutMs: SIGNAL_VERSION_PROBE_TIMEOUT_MS,
    });
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

function isSignalAccountConfigured(config: SignalAccountConfig): boolean {
  return Boolean(
    config.account?.trim() ||
    config.httpUrl?.trim() ||
    config.cliPath?.trim() ||
    config.httpHost?.trim() ||
    typeof config.httpPort === "number" ||
    typeof config.autoStart === "boolean",
  );
}

function listSignalHealthAccountIds(cfg: OpenClawConfig): string[] {
  const configuredIds = Object.keys(cfg.channels?.signal?.accounts ?? {})
    .filter(Boolean)
    .map((accountId) => normalizeAccountId(accountId))
    .filter(Boolean);
  return configuredIds.length > 0
    ? [...new Set(configuredIds)].toSorted((left, right) => left.localeCompare(right))
    : [DEFAULT_ACCOUNT_ID];
}

function formatSignalHealthAccountLabel(accountId: string): string {
  return accountId === DEFAULT_ACCOUNT_ID ? "default" : accountId;
}

function listConfiguredSignalVersionHealthTargets(
  cfg: OpenClawConfig,
): SignalVersionHealthTarget[] {
  const signalConfig = cfg.channels?.signal;
  if (!signalConfig || signalConfig.enabled === false) {
    return [];
  }

  return listSignalHealthAccountIds(cfg)
    .map((accountId) => {
      const accountConfig = signalConfig.accounts?.[accountId];
      const merged = resolveMergedAccountConfig<SignalAccountConfig>({
        channelConfig: signalConfig as SignalAccountConfig | undefined,
        accounts: signalConfig.accounts as Record<string, Partial<SignalAccountConfig>> | undefined,
        accountId,
      });
      const effectiveAutoStart = merged.autoStart ?? !merged.httpUrl?.trim();
      const explicitCliPath = accountConfig?.cliPath?.trim() || signalConfig.cliPath?.trim();
      const cliPath = effectiveAutoStart ? explicitCliPath || "signal-cli" : null;
      const cliSourceLabel = !effectiveAutoStart
        ? null
        : explicitCliPath
          ? accountConfig?.cliPath?.trim()
            ? `channels.signal.accounts.${accountId}.cliPath`
            : "channels.signal.cliPath"
          : accountId === DEFAULT_ACCOUNT_ID
            ? 'channels.signal.cliPath (default "signal-cli")'
            : `channels.signal.accounts.${accountId}.cliPath (default "signal-cli")`;
      const host = merged.httpHost?.trim() || "127.0.0.1";
      const port = merged.httpPort ?? 8080;
      return {
        accountId,
        accountLabel: formatSignalHealthAccountLabel(accountId),
        baseUrl: merged.httpUrl?.trim() || `http://${host}:${port}`,
        effectiveAutoStart,
        cliPath,
        cliSourceLabel,
        merged,
      };
    })
    .filter(({ merged }) => isSignalAccountConfigured(merged) && merged.enabled !== false)
    .map(({ merged: _merged, ...target }) => target);
}

async function probeSignalDaemonVersion(baseUrl: string): Promise<SignalDaemonVersionProbe> {
  try {
    const probe = await probeSignal(baseUrl, SIGNAL_VERSION_PROBE_TIMEOUT_MS);
    const version =
      typeof probe.version === "string" && probe.version.trim() ? probe.version.trim() : null;
    if (version) {
      return { version, error: null };
    }
    const error =
      typeof probe.error === "string" && probe.error.trim()
        ? probe.error.trim()
        : probe.ok
          ? "version RPC unavailable"
          : "daemon unreachable";
    return { version: null, error };
  } catch (error) {
    return {
      version: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildSignalCliFixLines(params: {
  installKind: "workspace" | "managed" | "system";
  cliSourceLabel: string;
}): string[] {
  if (params.installKind === "workspace") {
    return [
      "- This looks like a workspace-local build, so update/rebuild the local Signal CLI in the repo and verify the configured path again.",
      `- If you do not want workspace drift, point ${params.cliSourceLabel} at a separately installed signal-cli instead.`,
    ];
  }
  if (params.installKind === "managed") {
    return [
      "- This looks like an OpenClaw-managed install, so rerun the Signal CLI install/update flow to refresh it.",
      "- After updating, rerun doctor to verify the version floor.",
    ];
  }
  return [
    `- This looks like a system install, so upgrade signal-cli with your package manager or replace ${params.cliSourceLabel} with a newer binary.`,
    "- After updating, rerun doctor to verify the version floor.",
  ];
}

export async function noteSignalCliVersionHealth(
  root: string | null,
  cfg: OpenClawConfig,
): Promise<void> {
  const configuredTargets = listConfiguredSignalVersionHealthTargets(cfg);
  if (configuredTargets.length === 0) {
    return;
  }

  for (const configuredTarget of configuredTargets) {
    const daemonProbe = await probeSignalDaemonVersion(configuredTarget.baseUrl);
    if (daemonProbe.version) {
      const cmp = compareSemverStrings(daemonProbe.version, MIN_SIGNAL_CLI_VERSION);
      if (cmp != null && cmp >= 0) {
        continue;
      }

      if (!configuredTarget.effectiveAutoStart || !configuredTarget.cliPath) {
        note(
          [
            `- Signal daemon ${daemonProbe.version} at ${configuredTarget.baseUrl} is below the minimum supported version ${MIN_SIGNAL_CLI_VERSION} for the current OpenClaw Signal feature set.`,
            `- signal account: ${configuredTarget.accountLabel}`,
            "- This account uses an existing Signal daemon, so upgrade that daemon and rerun doctor.",
          ].join("\n"),
          "Install",
        );
        continue;
      }

      const installKind = classifySignalCliInstall({
        root,
        cliPath: configuredTarget.cliPath,
      });
      note(
        [
          `- Signal daemon ${daemonProbe.version} at ${configuredTarget.baseUrl} is below the minimum supported version ${MIN_SIGNAL_CLI_VERSION} for the current OpenClaw Signal feature set.`,
          `- signal account: ${configuredTarget.accountLabel}`,
          `- local signal-cli path: ${configuredTarget.cliPath}`,
          `- local CLI setting: ${configuredTarget.cliSourceLabel}`,
          ...buildSignalCliFixLines({
            installKind,
            cliSourceLabel: configuredTarget.cliSourceLabel ?? "channels.signal.cliPath",
          }),
        ].join("\n"),
        "Install",
      );
      continue;
    }

    if (!configuredTarget.effectiveAutoStart || !configuredTarget.cliPath) {
      note(
        [
          `- doctor could not verify the Signal daemon version at ${configuredTarget.baseUrl}.`,
          `- signal account: ${configuredTarget.accountLabel}`,
          daemonProbe.error ? `- last probe error: ${daemonProbe.error}` : "",
          `- This account relies on an existing daemon, so confirm it is running signal-cli ${MIN_SIGNAL_CLI_VERSION} or newer and rerun doctor.`,
        ]
          .filter(Boolean)
          .join("\n"),
        "Install",
      );
      continue;
    }

    const version = await probeSignalCliVersion(configuredTarget.cliPath);
    if (!version) {
      note(
        [
          `- doctor could not verify the Signal version for account ${configuredTarget.accountLabel}.`,
          `- daemon URL: ${configuredTarget.baseUrl}`,
          `- local signal-cli path: ${configuredTarget.cliPath}`,
          `- local CLI setting: ${configuredTarget.cliSourceLabel}`,
          daemonProbe.error ? `- last daemon probe error: ${daemonProbe.error}` : "",
          "- Quick check: <configured signal-cli path> --version",
        ]
          .filter(Boolean)
          .join("\n"),
        "Install",
      );
      continue;
    }

    const cmp = compareSemverStrings(version, MIN_SIGNAL_CLI_VERSION);
    if (cmp != null && cmp >= 0) {
      continue;
    }

    const installKind = classifySignalCliInstall({ root, cliPath: configuredTarget.cliPath });
    note(
      [
        `- signal-cli ${version} is below the minimum supported version ${MIN_SIGNAL_CLI_VERSION} for the current OpenClaw Signal feature set.`,
        `- signal account: ${configuredTarget.accountLabel}`,
        `- doctor could not verify the running daemon at ${configuredTarget.baseUrl}, so this check used the local auto-start binary instead.`,
        `- configured path: ${configuredTarget.cliPath}`,
        `- local CLI setting: ${configuredTarget.cliSourceLabel}`,
        ...buildSignalCliFixLines({
          installKind,
          cliSourceLabel: configuredTarget.cliSourceLabel ?? "channels.signal.cliPath",
        }),
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
